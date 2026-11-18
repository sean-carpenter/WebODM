PluginsAPI.Map.willAddControls([
		'timeline/build/Timeline.js',
		'timeline/build/Timeline.css'
	], function(args, Timeline){
	var tasks = {};
	var projects = {};

	for (var i = 0; i < args.tiles.length; i++){
		var task = args.tiles[i].meta.task;
		tasks[task.id] = true;
		projects[task.project] = true;
	}

	var projectIds = Object.keys(projects);

	// Only meaningful on a project map with more than one flight
	if (Object.keys(tasks).length >= 2 && projectIds.length === 1){
		args.map.addControl(new Timeline({
			map: args.map,
			tiles: args.tiles,
			projectId: projectIds[0]
		}));
	}
});
