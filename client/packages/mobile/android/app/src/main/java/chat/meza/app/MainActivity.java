package chat.meza.app;

import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onStart() {
        super.onStart();

        // In debug builds, accept self-signed certificates so the HTTPS
        // dev server (used by `task dev:mobile`) works in the WebView.
        // This enables crypto.subtle which requires a secure context.
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().setWebViewClient(
                new com.getcapacitor.BridgeWebViewClient(getBridge()) {
                    @Override
                    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                        handler.proceed();
                    }
                }
            );
        }

        // Microphone permissions: Capacitor's built-in BridgeWebChromeClient
        // already handles onPermissionRequest — it launches the Android runtime
        // permission dialog for RECORD_AUDIO when getUserMedia is called.
        // Do NOT override setWebChromeClient here or it replaces that handler.
    }
}
