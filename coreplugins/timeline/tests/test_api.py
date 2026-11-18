import json
import os
from datetime import datetime, timezone

from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.test import APIClient

from app.geoutils import bbox_to_polygon
from app.models import Project, Task
from app.models.task import status_codes
from app.tests.classes import BootTestCase


def ts(year, month, day):
    return datetime(year, month, day, 12, tzinfo=timezone.utc).timestamp()


class TestTimelineApi(BootTestCase):
    def setUp(self):
        super().setUp()
        self.user = User.objects.get(username="testuser")
        self.project = Project.objects.create(owner=self.user, name="construction job")

    def make_task(self, name, created, capture_times=None, completed=True, extent=True):
        task = Task.objects.create(
            project=self.project,
            name=name,
            status=status_codes.COMPLETED if completed else status_codes.RUNNING,
            orthophoto_extent=bbox_to_polygon([1, 2, 3, 4]) if extent else None,
        )
        Task.objects.filter(pk=task.pk).update(created_at=datetime.fromtimestamp(created, tz=timezone.utc))

        if capture_times is not None:
            path = task.assets_path('odm_report', 'shots.geojson')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w') as f:
                json.dump({
                    'type': 'FeatureCollection',
                    'features': [{'type': 'Feature', 'geometry': None,
                                  'properties': {'filename': 'img{}.jpg'.format(i), 'capture_time': t}}
                                 for i, t in enumerate(capture_times)]
                }, f)
            Task.objects.filter(pk=task.pk).update(available_assets=['orthophoto.tif', 'shots.geojson'])

        return task

    def url(self, project=None):
        return '/api/plugins/timeline/project/{}/timeline'.format((project or self.project).id)

    def test_orders_by_capture_date_with_created_at_fallback(self):
        # Processed out of order; capture dates tell the real sequence
        march = self.make_task("march flight", created=ts(2026, 6, 1), capture_times=[ts(2026, 3, 2), ts(2026, 3, 1)])
        may = self.make_task("may flight", created=ts(2026, 5, 20))  # no shots.geojson
        jan_ms = self.make_task("jan flight (ms)", created=ts(2026, 6, 2), capture_times=[ts(2026, 1, 15) * 1000])
        self.make_task("still running", created=ts(2026, 6, 3), capture_times=[ts(2026, 2, 1)], completed=False)
        self.make_task("no layers", created=ts(2026, 6, 4), extent=False)

        client = APIClient()
        client.login(username="testuser", password="test1234")
        res = client.get(self.url())
        self.assertEqual(res.status_code, status.HTTP_200_OK)

        tasks = res.data['tasks']
        self.assertEqual([t['id'] for t in tasks], [str(jan_ms.id), str(march.id), str(may.id)])

        self.assertTrue(tasks[0]['flown_at'].startswith('2026-01-15'))
        self.assertEqual(tasks[0]['flown_at_source'], 'capture_time')
        self.assertTrue(tasks[1]['flown_at'].startswith('2026-03-01'))  # earliest shot wins
        self.assertTrue(tasks[2]['flown_at'].startswith('2026-05-20'))
        self.assertEqual(tasks[2]['flown_at_source'], 'created_at')

    def test_corrupt_shots_file_falls_back(self):
        task = self.make_task("bad shots", created=ts(2026, 4, 1), capture_times=[])
        with open(task.assets_path('odm_report', 'shots.geojson'), 'w') as f:
            f.write("not json")

        client = APIClient()
        client.login(username="testuser", password="test1234")
        res = client.get(self.url())
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data['tasks'][0]['flown_at_source'], 'created_at')

    def test_permissions(self):
        self.make_task("flight", created=ts(2026, 4, 1))

        # Anonymous
        res = APIClient().get(self.url())
        self.assertIn(res.status_code, (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND))

        # Another user
        client = APIClient()
        client.login(username="testuser2", password="test1234")
        self.assertEqual(client.get(self.url()).status_code, status.HTTP_404_NOT_FOUND)

        # Missing project
        client.login(username="testuser", password="test1234")
        self.assertEqual(client.get('/api/plugins/timeline/project/999999/timeline').status_code, status.HTTP_404_NOT_FOUND)
