import SwiftUI

extension Platform {
    var serviceTitle: String { line.displayTitle(routes: routes ?? []) }
}

private extension TransitLine {
    func displayTitle(routes: [String]) -> String {
        guard self == .green else { return title }
        let branches = ["B", "C", "D", "E"].filter { routes.contains("Green-\($0)") }
        return branches.isEmpty ? title : "\(title) \(branches.joined(separator: "/"))"
    }
}

struct StationPickerView: View {
    @Environment(\.dismiss) private var dismiss

    let platforms: [Platform]
    let selectedPlatformID: String
    let mode: GameMode
    let select: (Platform) -> Void

    var body: some View {
        let platformsByLine = Dictionary(grouping: platforms, by: \.line)
        let lines = TransitLine.allCases.filter { platformsByLine[$0] != nil }

        NavigationStack {
            List(lines, id: \.self) { line in
                NavigationLink {
                    LineStationsView(
                        line: line,
                        platforms: platformsByLine[line, default: []],
                        selectedPlatformID: selectedPlatformID,
                        mode: mode,
                        select: select
                    )
                } label: {
                    Label {
                        Text(line.title)
                    } icon: {
                        Image(systemName: "tram.fill")
                            .foregroundStyle(BoardColor.line(line))
                            .accessibilityHidden(true)
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("Choose a line")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

private struct LineStationsView: View {
    @State private var searchText = ""

    private struct Station: Identifiable {
        let id: String
        let name: String
        let platforms: [Platform]
        let branchSummary: String?
    }

    private let line: TransitLine
    private let stations: [Station]
    private let selectedPlatformID: String
    private let mode: GameMode
    private let select: (Platform) -> Void

    init(line: TransitLine, platforms: [Platform], selectedPlatformID: String, mode: GameMode, select: @escaping (Platform) -> Void) {
        self.line = line
        self.mode = mode
        let grouped = Dictionary(grouping: platforms) { $0.stationID ?? $0.station }
        stations = grouped.compactMap { id, platforms in
            guard let first = platforms.first else { return nil }
            let service = line.displayTitle(routes: platforms.flatMap { $0.routes ?? [] })
            return Station(id: id, name: first.station, platforms: platforms, branchSummary: service == line.title ? nil : service)
        }.sorted { lhs, rhs in
            if lhs.name == rhs.name { return lhs.id < rhs.id }
            return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
        }
        self.selectedPlatformID = selectedPlatformID
        self.select = select
    }

    var body: some View {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let results = query.isEmpty ? stations : stations.filter {
            $0.name.localizedStandardContains(query) || $0.branchSummary?.localizedStandardContains(query) == true
        }

        List(results) { station in
            DisclosureGroup {
                ForEach(station.platforms) { platform in
                    directionButton(platform)
                }
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(station.name)
                    if let branches = station.branchSummary {
                        Text(branches)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .overlay {
            if results.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search stations")
        .navigationTitle(line.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func directionButton(_ platform: Platform) -> some View {
        let isSelected = platform.id == selectedPlatformID
        let departuresOnly = mode == .live && platform.supportsArrivalRounds == false
        return Button {
            select(platform)
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(platform.direction)
                        .foregroundStyle(.primary)
                    if platform.line == .green && platform.serviceTitle != platform.line.title {
                        Text(platform.serviceTitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if departuresOnly {
                        Text("Departures only")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(BoardColor.warning)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(BoardColor.signal)
                        .accessibilityHidden(true)
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(platform.direction)
        .accessibilityValue(departuresOnly ? "\(platform.serviceTitle), departures only" : platform.serviceTitle)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
