import Capacitor

class MezaViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FCMTokenPlugin())
    }
}
