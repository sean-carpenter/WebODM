import L from 'leaflet';
import ReactDOM from 'ReactDOM';
import React from 'React';
import PropTypes from 'prop-types';
import $ from 'jquery';
import { _ } from 'webodm/classes/gettext';
import Utils from 'webodm/classes/Utils';
import './Timeline.scss';

const TILESIZE = 512;
const PLAY_INTERVAL_MS = 2000;
const PREFERRED_TYPES = ['orthophoto', 'dsm', 'dtm', 'plant'];

const hasBands = (bands, orthophotoBands) => {
  if (!orthophotoBands) return false;
  const names = orthophotoBands.map(b => (b.description || "").toLowerCase());
  return bands.every(b => names.indexOf(b) !== -1);
};

// Same tile parameters the core Map uses, so a flight looks the same in both
const metadataParams = (type, task) => {
  let params = {};
  if (type === 'plant'){
    if (task.orthophoto_bands && task.orthophoto_bands.length === 2){
      params = { formula: 'Celsius', bands: 'L', color_map: 'magma' };
    }else if (task.orthophoto_bands){
      params = { formula: hasBands(["red", "green", "nir"], task.orthophoto_bands) ? "NDVI" : "VARI", bands: 'auto', color_map: 'rdylgn' };
    }else{
      params = { formula: 'NDVI', bands: 'RGN', color_map: 'rdylgn' };
    }
  }else if (type === 'dsm' || type === 'dtm'){
    params = { hillshade: 6, color_map: 'viridis' };
  }
  if (task.crop) params.crop = 1;
  return params;
};

const tileUrlFromMetadata = (type, task, mres) => {
  let tileUrl = mres.tiles[0];
  const params = Utils.queryParams({search: tileUrl.indexOf("?") !== -1 ? tileUrl.slice(tileUrl.indexOf("?")) : ""});
  const { statistics } = mres;

  if (statistics){
    if (statistics["1"]){
      let min = Infinity, max = -Infinity;
      if (type === 'plant'){
        for (let b in statistics){
          min = Math.min(min, statistics[b]["percentiles"][0]);
          max = Math.max(max, statistics[b]["percentiles"][1]);
        }
      }else{
        let bandsIdx = Object.keys(statistics);
        const rgb = ["red", "green", "blue"];
        if (type === 'orthophoto' && hasBands(rgb, task.orthophoto_bands)){
          bandsIdx = rgb.map(d => String(task.orthophoto_bands.map(ob => (ob.description || "").toLowerCase()).indexOf(d) + 1));
        }
        bandsIdx.forEach(b => {
          min = Math.min(min, statistics[b]["min"]);
          max = Math.max(max, statistics[b]["max"]);
        });
      }
      params.rescale = encodeURIComponent(`${min},${max}`);
    }else{
      params.rescale = encodeURIComponent("-1,1");
    }
  }

  params.size = TILESIZE;
  if (task.crop) params.crop = 1;
  return Utils.buildUrlWithQuery(tileUrl, params);
};

const formatDate = iso => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

class TimelinePanel extends React.Component {
  static propTypes = {
    map: PropTypes.object.isRequired,
    tiles: PropTypes.array.isRequired,
    projectId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired
  }

  constructor(props){
    super(props);

    // taskId -> { task meta, tiles: { type: base url } }
    this.taskTiles = {};
    props.tiles.forEach(t => {
      const task = t.meta.task;
      if (!this.taskTiles[task.id]) this.taskTiles[task.id] = { task, tiles: {} };
      this.taskTiles[task.id].tiles[t.type] = t.url;
    });

    const types = PREFERRED_TYPES.filter(type => props.tiles.some(t => t.type === type));

    this.state = {
      loading: true,
      error: "",
      flights: [],    // [{id, name, flown_at, flown_at_source}] oldest first
      index: 0,
      active: false,
      playing: false,
      mapType: types.length ? types[0] : 'orthophoto',
      layerError: ""
    };

    this.layerCache = {}; // "taskId:type" -> Promise<L.TileLayer>
    this.currentLayer = null;
    this.hiddenCoreLayers = [];
  }

  componentDidMount(){
    PluginsAPI.Map.onMapTypeChanged(this.handleMapTypeChanged);

    this.request = $.getJSON(`/api/plugins/timeline/project/${this.props.projectId}/timeline`)
      .done(res => {
        const flights = (res.tasks || []).filter(t => this.taskTiles[t.id]);
        this.setState({ flights, index: Math.max(0, flights.length - 1), loading: false });
      })
      .fail(() => {
        this.setState({ loading: false, error: _("Cannot load the timeline") });
      });
  }

  componentWillUnmount(){
    PluginsAPI.Map.offMapTypeChanged(this.handleMapTypeChanged);
    if (this.request) this.request.abort();
    this.stopPlaying();
    this.deactivate();
  }

  componentDidUpdate(prevProps, prevState){
    const { active, index, mapType } = this.state;
    if (active !== prevState.active){
      if (active) this.activate();
      else this.deactivate();
    }else if (active && (index !== prevState.index || mapType !== prevState.mapType)){
      this.showFlight();
    }
  }

  handleMapTypeChanged = (mapType) => {
    this.setState({ mapType });
    return false; // let other listeners run
  }

  // Core raster layers are tagged with a "meta" symbol; ours are not.
  isCoreRaster = layer => {
    const meta = layer[Symbol.for("meta")];
    return !!(meta && meta.raster);
  }

  hideCoreLayer = layer => {
    if (!this.isCoreRaster(layer) || !layer.getContainer || !layer.getContainer()) return;
    layer.getContainer().style.display = 'none';
    if (this.hiddenCoreLayers.indexOf(layer) === -1) this.hiddenCoreLayers.push(layer);
  }

  handleLayerAdd = e => {
    this.hideCoreLayer(e.layer);
  }

  activate(){
    const { map } = this.props;
    map.eachLayer(this.hideCoreLayer);
    map.on('layeradd', this.handleLayerAdd);
    this.showFlight();
  }

  deactivate(){
    const { map } = this.props;
    map.off('layeradd', this.handleLayerAdd);
    if (this.currentLayer){
      map.removeLayer(this.currentLayer);
      this.currentLayer = null;
    }
    this.hiddenCoreLayers.forEach(layer => {
      if (layer.getContainer && layer.getContainer()) layer.getContainer().style.display = '';
    });
    this.hiddenCoreLayers = [];
  }

  // Best available type for this flight: the map's type, else the first one it has
  typeFor(taskId){
    const tiles = this.taskTiles[taskId].tiles;
    if (tiles[this.state.mapType]) return this.state.mapType;
    return PREFERRED_TYPES.find(t => tiles[t]);
  }

  getLayer(taskId, type){
    const key = `${taskId}:${type}`;
    if (!this.layerCache[key]){
      const { task, tiles } = this.taskTiles[taskId];
      const metaUrl = tiles[type] + "metadata" + Utils.toSearchQuery(metadataParams(type, task));

      this.layerCache[key] = new Promise((resolve, reject) => {
        $.getJSON(metaUrl).done(mres => {
          const bounds = L.latLngBounds(
            [mres.bounds.value.slice(0, 2).reverse(), mres.bounds.value.slice(2, 4).reverse()]
          );
          const layer = L.tileLayer(tileUrlFromMetadata(type, task, mres), {
            bounds,
            minZoom: 0,
            maxZoom: mres.maxzoom + 99,
            maxNativeZoom: mres.maxzoom - 1,
            tileSize: TILESIZE,
            tms: mres.scheme === 'tms',
            detectRetina: true,
            zIndex: 2000,
            className: 'timeline-layer'
          });
          layer.timelineTaskId = taskId;
          resolve(layer);
        }).fail(() => {
          delete this.layerCache[key];
          reject(new Error(_("Cannot load this flight's map layer")));
        });
      });
    }
    return this.layerCache[key];
  }

  showFlight(){
    const { flights, index } = this.state;
    const flight = flights[index];
    if (!flight) return;

    const type = this.typeFor(flight.id);
    const token = this.showToken = {};

    this.getLayer(flight.id, type).then(layer => {
      if (token !== this.showToken || !this.state.active) return; // a newer request won
      const { map } = this.props;
      if (this.currentLayer && this.currentLayer !== layer) map.removeLayer(this.currentLayer);
      if (!map.hasLayer(layer)) layer.addTo(map);
      this.currentLayer = layer;
      if (this.state.layerError) this.setState({ layerError: "" });

      // Warm the cache for the neighbours so stepping is quick
      [index - 1, index + 1].forEach(i => {
        if (flights[i]) this.getLayer(flights[i].id, this.typeFor(flights[i].id)).catch(() => {});
      });
    }).catch(e => {
      if (token === this.showToken) this.setState({ layerError: e.message });
    });
  }

  toggleActive = () => {
    if (this.state.active) this.stopPlaying();
    this.setState({ active: !this.state.active });
  }

  setIndex = index => {
    const { flights } = this.state;
    index = Math.max(0, Math.min(flights.length - 1, index));
    this.setState({ index, active: true });
  }

  handleSlider = e => {
    this.stopPlaying();
    this.setIndex(parseInt(e.target.value, 10));
  }

  prev = () => { this.stopPlaying(); this.setIndex(this.state.index - 1); }
  next = () => { this.stopPlaying(); this.setIndex(this.state.index + 1); }

  togglePlay = () => {
    if (this.state.playing){
      this.stopPlaying();
      return;
    }
    const { flights, index } = this.state;
    // From the last flight, play restarts at the first one
    this.setState({ playing: true, active: true, index: index >= flights.length - 1 ? 0 : index });
    this.playTimer = setInterval(() => {
      const { index, flights } = this.state;
      if (index >= flights.length - 1) this.stopPlaying();
      else this.setState({ index: index + 1 });
    }, PLAY_INTERVAL_MS);
  }

  stopPlaying(){
    if (this.playTimer){
      clearInterval(this.playTimer);
      this.playTimer = null;
    }
    if (this.state.playing) this.setState({ playing: false });
  }

  render(){
    const { loading, error, flights, index, active, playing, layerError } = this.state;

    if (loading) return (<div className="timeline-panel"><i className="fa fa-circle-notch fa-spin fa-fw"></i> {_("Loading timeline…")}</div>);
    if (error) return (<div className="timeline-panel timeline-error">{error}</div>);
    if (flights.length < 2) return null;

    const flight = flights[index];

    return (<div className={"timeline-panel" + (active ? " active" : "")}>
      <div className="timeline-row">
        <button type="button" className={"btn btn-sm timeline-toggle " + (active ? "btn-primary" : "btn-secondary")}
                onClick={this.toggleActive} title={active ? _("Stop the timeline and show all layers") : _("Show one flight at a time")}>
          <i className="fa fa-clock"></i> {_("Timeline")}
        </button>
        <button type="button" className="btn btn-sm btn-secondary timeline-prev" onClick={this.prev} disabled={index === 0} title={_("Previous flight")}>
          <i className="fa fa-step-backward"></i>
        </button>
        <button type="button" className="btn btn-sm btn-secondary timeline-play" onClick={this.togglePlay} title={playing ? _("Pause") : _("Play")}>
          <i className={"fa " + (playing ? "fa-pause" : "fa-play")}></i>
        </button>
        <button type="button" className="btn btn-sm btn-secondary timeline-next" onClick={this.next} disabled={index === flights.length - 1} title={_("Next flight")}>
          <i className="fa fa-step-forward"></i>
        </button>
        <input type="range" className="timeline-slider" min="0" max={flights.length - 1} step="1"
               value={index} onChange={this.handleSlider} aria-label={_("Flight")} list="timeline-ticks" />
        <datalist id="timeline-ticks">
          {flights.map((f, i) => <option key={f.id} value={i} />)}
        </datalist>
      </div>
      <div className="timeline-label">
        <span className="timeline-date" title={flight.flown_at_source === 'created_at' ? _("Capture date unknown; showing the processing date") : _("Capture date")}>
          {formatDate(flight.flown_at)}{flight.flown_at_source === 'created_at' ? "*" : ""}
        </span>
        <span className="timeline-name">{flight.name}</span>
        <span className="timeline-count">{index + 1} / {flights.length}</span>
      </div>
      {layerError ? <div className="timeline-error">{layerError}</div> : ""}
    </div>);
  }
}

export default L.Control.extend({
  options: {
    position: 'bottomleft'
  },

  onAdd: function(map){
    const container = L.DomUtil.create('div', 'leaflet-control-timeline leaflet-bar leaflet-control');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    ReactDOM.render(<TimelinePanel map={this.options.map} tiles={this.options.tiles} projectId={this.options.projectId} />, container);
    this._container = container;
    return container;
  },

  onRemove: function(){
    if (this._container) ReactDOM.unmountComponentAtNode(this._container);
  }
});
