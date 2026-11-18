import json
import logging
from datetime import datetime, timezone

from django.db.models import Q
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from app.api.common import get_and_check_project
from app.models import Project, Task
from app.models.task import status_codes

logger = logging.getLogger('app.logger')


def _to_iso(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def earliest_capture_time(task):
    """
    Earliest photo capture time (seconds since epoch) found in the task's
    shots.geojson, or None when the file or the capture_time field is missing.
    """
    if 'shots.geojson' not in (task.available_assets or []):
        return None

    try:
        with open(task.assets_path('odm_report', 'shots.geojson'), 'r') as f:
            shots = json.load(f)
    except (OSError, ValueError) as e:
        logger.warning("Timeline: cannot read shots.geojson for task {}: {}".format(task.id, e))
        return None

    times = []
    for feature in shots.get('features', []) if isinstance(shots, dict) else []:
        value = (feature.get('properties') or {}).get('capture_time')
        if isinstance(value, (int, float)) and value > 0:
            # OpenSfM writes seconds; tolerate milliseconds too
            times.append(value / 1000.0 if value > 1e11 else float(value))

    return min(times) if times else None


class ProjectTimeline(APIView):
    """
    The project's completed tasks that have map layers, oldest flight first.
    flown_at is the earliest photo capture time, or created_at when unknown.
    """
    # Same pattern as app.api.tasks.TaskNestedView: the object-level check
    # happens in get_and_check_project (404 without view_project).
    queryset = Project.objects.all()
    permission_classes = (AllowAny, )

    def get(self, request, project_pk=None):
        project = get_and_check_project(request, project_pk)

        tasks = (Task.objects.filter(project=project, status=status_codes.COMPLETED)
                 .filter(Q(orthophoto_extent__isnull=False) | Q(dsm_extent__isnull=False) | Q(dtm_extent__isnull=False))
                 .only('id', 'name', 'created_at', 'available_assets', 'project'))

        items = []
        for task in tasks:
            created_at = task.created_at.timestamp()
            captured = earliest_capture_time(task)
            items.append({
                'id': str(task.id),
                'name': task.name,
                'created_at': _to_iso(created_at),
                'flown_at': _to_iso(captured if captured is not None else created_at),
                'flown_at_source': 'capture_time' if captured is not None else 'created_at',
            })

        items.sort(key=lambda t: (t['flown_at'], t['created_at']))
        return Response({'tasks': items})
