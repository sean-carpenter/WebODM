from app.plugins import PluginBase
from app.plugins import MountPoint
from .api import ProjectTimeline


class Plugin(PluginBase):
    def include_js_files(self):
        return ['main.js']

    def build_jsx_components(self):
        return ['Timeline.jsx']

    def api_mount_points(self):
        return [
            MountPoint('project/(?P<project_pk>[^/.]+)/timeline', ProjectTimeline.as_view()),
        ]
