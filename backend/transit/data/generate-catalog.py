"""Generate the subway platforms from an official MBTA GTFS ZIP."""

import argparse
import csv
import io
import json
from pathlib import Path
import zipfile

LINES = {
    'Red': 'red',
    'Orange': 'orange',
    'Blue': 'blue',
    'Mattapan': 'mattapan',
    **{f'Green-{branch}': 'green' for branch in 'BCDE'},
}

LEGACY_PLATFORMS = {
    ('place-dwnxg', 'red', 0, '70077'): ('red-ashmont', 'Ashmont / Braintree'),
    ('place-dwnxg', 'orange', 0, '70020'): ('orange-forest-hills', 'Forest Hills'),
}


def records(archive, name):
    with io.TextIOWrapper(archive.open(f'{name}.txt'), encoding='utf-8-sig', newline='') as source:
        yield from csv.DictReader(source)


def build_catalog(archive):
    stops = {row['stop_id']: row for row in records(archive, 'stops')}
    destinations = {
        (row['route_id'], int(row['direction_id'])): row['direction_destination']
        for row in records(archive, 'directions') if row['route_id'] in LINES
    }
    trips = {
        row['trip_id']: (row['route_id'], int(row['direction_id']))
        for row in records(archive, 'trips') if row['route_id'] in LINES
    }
    first_sequences = {}
    for row in records(archive, 'stop_times'):
        trip_id = row['trip_id']
        if trip_id in trips:
            sequence = int(row['stop_sequence'])
            first_sequences[trip_id] = min(first_sequences.get(trip_id, sequence), sequence)

    platforms = {}
    for row in records(archive, 'stop_times'):
        trip = trips.get(row['trip_id'])
        if not trip or (row['pickup_type'] == '1' and row['drop_off_type'] == '1'):
            continue
        route, direction_id = trip
        stop_id = row['stop_id']
        station_id = stops[stop_id]['parent_station'] or stop_id
        key = (station_id, LINES[route], direction_id, stop_id)
        platform = platforms.setdefault(key, {'routes': set(), 'can_board': False, 'can_arrive': False})
        platform['routes'].add(route)
        platform['can_board'] |= row['pickup_type'] != '1'
        platform['can_arrive'] |= int(row['stop_sequence']) > first_sequences[row['trip_id']]

    entries = []
    for key, platform in platforms.items():
        station_id, line, direction_id, stop_id = key
        station = stops[station_id]['stop_name']
        route_ids = sorted(platform['routes'])
        heading = stops[stop_id].get('platform_name', '').strip()
        if not heading:
            names = {destinations.get((route, direction_id), '') for route in route_ids}
            heading = ' / '.join(sorted(names - {''})) or f'Direction {direction_id + 1}'
        if not platform['can_board']:
            heading = f'Arrivals at {station}'
        platform_id, heading = LEGACY_PLATFORMS.get(key, (f'{station_id}:{line}:{direction_id}:{stop_id}', heading))
        entries.append({
            'id': platform_id,
            'stationId': station_id,
            'station': station,
            'line': line,
            'direction': heading,
            'directionId': direction_id,
            'routes': route_ids,
            'stopIds': [stop_id],
        })
        if not platform['can_arrive']:
            entries[-1]['supportsArrivalRounds'] = False

    entries.sort(key=lambda row: (row['station'].casefold(), row['stationId'], row['line'], row['directionId'], row['id']))
    feed = next(records(archive, 'feed_info'))
    return {'feedVersion': feed['feed_version'], 'platforms': entries}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='Official MBTA GTFS ZIP')
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('subway-platforms.json'))
    args = parser.parse_args()

    with zipfile.ZipFile(args.archive) as archive:
        catalog = build_catalog(archive)
    with args.output.open('w', encoding='utf-8') as output:
        json.dump(catalog, output, ensure_ascii=False, indent=2)
        output.write('\n')


if __name__ == '__main__':
    main()
