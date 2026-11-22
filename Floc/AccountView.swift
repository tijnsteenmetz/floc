import SwiftUI

/// Sign in or create an account. Shown until you're signed in.
struct AccountView: View {
    @ObservedObject var session = Session.shared
    @State private var register = false
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("f").font(.system(size: 30, weight: .heavy)).foregroundStyle(Theme.bg)
                    .frame(width: 60, height: 60).background(Theme.text, in: RoundedRectangle(cornerRadius: 18))
                    .padding(.top, 48)
                Text(register ? "Account maken" : "Welkom bij floc")
                    .font(.system(size: 32, weight: .semibold)).tracking(-0.5)
                Text("Vind podia, bars, WC's en je eigen tent terug op het festivalterrein, ook zonder bereik.")
                    .foregroundStyle(Theme.muted)

                VStack(spacing: 10) {
                    if register { field("Naam", text: $name, content: .name) }
                    field("E-mail", text: $email, content: .emailAddress, keyboard: .emailAddress)
                    field(register ? "Wachtwoord (minstens 8 tekens)" : "Wachtwoord", text: $password, secure: true,
                          content: register ? .newPassword : .password)
                }
                .padding(.top, 8)

                if let error { Text(error).font(.system(size: 14)).foregroundStyle(Theme.danger) }

                Button(action: submit) {
                    HStack { if busy { ProgressView().tint(Theme.bg) }; Text(register ? "Account maken" : "Inloggen") }
                        .font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.bg)
                        .frame(maxWidth: .infinity).frame(height: 54)
                        .background(Theme.lime, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .disabled(busy || email.isEmpty || password.isEmpty)

                Button(register ? "Ik heb al een account" : "Nog geen account? Maak er een") {
                    register.toggle(); error = nil
                }
                .font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.lime)
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 20)
        }
        .background(Theme.bg)
        .scrollDismissesKeyboard(.interactively)
    }

    private func field(_ label: String, text: Binding<String>, secure: Bool = false, content: UITextContentType, keyboard: UIKeyboardType = .default) -> some View {
        Group {
            if secure { SecureField(label, text: text) } else { TextField(label, text: text) }
        }
        .textContentType(content)
        .keyboardType(keyboard)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 16).frame(height: 52)
        .background(Theme.cardSolid, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
    }

    private func submit() {
        busy = true; error = nil
        Task {
            do {
                let r = register
                    ? try await Backend.register(email: email, password: password, name: name)
                    : try await Backend.login(email: email, password: password)
                session.signedIn(r)
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
