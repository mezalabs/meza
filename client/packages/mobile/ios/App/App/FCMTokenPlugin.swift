import Capacitor
import FirebaseMessaging

@objc(FCMTokenPlugin)
public class FCMTokenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FCMTokenPlugin"
    public let jsName = "FCMToken"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise)
    ]

    @objc func getToken(_ call: CAPPluginCall) {
        Messaging.messaging().token { token, error in
            if let error = error {
                call.reject("Failed to get FCM token", nil, error)
                return
            }
            call.resolve(["token": token ?? ""])
        }
    }
}
