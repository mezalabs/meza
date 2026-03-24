import Capacitor
import FirebaseCore
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
        Messaging.messaging().token { token, error in
            if let error = error {
                call.reject("Failed to get FCM token", nil, error)
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
