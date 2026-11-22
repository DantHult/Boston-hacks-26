import SwiftUI

@MainActor
struct ServerSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var address: String
    let save: (URL) -> Void

    init(server: URL, save: @escaping (URL) -> Void) {
        _address = State(initialValue: server.absoluteString)
        self.save = save
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server address", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(saveAddress)
                    Button("Use simulator address") {
                        address = GameModel.defaultServer.absoluteString
                    }
                } header: {
                    Text("Server address")
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("On a physical iPhone, join the Mac’s Wi-Fi network and enter its local hostname or IP address with port 3000.")
                        Text("Transit data provided by MassDOT and the MBTA.")
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: saveAddress)
                        .disabled(GameModel.serverURL(address) == nil)
                }
            }
        }
    }

    private func saveAddress() {
        guard let url = GameModel.serverURL(address) else { return }
        save(url)
        dismiss()
    }
}
