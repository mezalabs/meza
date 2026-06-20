import Capacitor
import FirebaseMessaging

/// Capacitor plugin that exposes the Firebase Cloud Messaging token to JS.
/// On iOS, @capacitor/push-notifications returns the raw APNs token, but the
/// server sends notifications via FCM — so we need the FCM-mapped token.
@objc(FCMTokenPlugin)
class FCMTokenPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "FCMTokenPlugin"
    let jsName = "FCMToken"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise),
    ]

    @objc func getToken(_ call: CAPPluginCall) {
        let apnsToken = Messaging.messaging().apnsToken
        Messaging.messaging().token { token, error in
            if let error = error {
                let nsError = error as NSError
                call.reject(
                    "Failed to get FCM token: \(nsError.localizedDescription) (domain=\(nsError.domain) code=\(nsError.code), apnsToken=\(apnsToken != nil ? "set" : "nil"))",
                    nil,
                    error
                )
                return
            }
            guard let token = token else {
                call.reject("FCM token was nil")
                return
            }
            call.resolve(["token": token])
        }
    }
}
