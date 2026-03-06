package chat.meza.app;

import android.graphics.Color;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.SslErrorHandler;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final int BG = Color.parseColor("#121212");

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Match system bar colors to the app's dark background.
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        getWindow().getDecorView().setBackgroundColor(BG);

        // Android 15 (SDK 35) enforces edge-to-edge, so the WebView draws
        // behind the status bar and navigation bar. Apply system bar insets
        // as padding on the root content view so app content is not obscured.
        View contentView = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(contentView, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }

    @Override
    public void onStart() {
        super.onStart();

        // Paint every view in the hierarchy dark to eliminate any
        // white bleed-through from Capacitor's internal containers.
        WebView wv = getBridge().getWebView();
        wv.setBackgroundColor(BG);
        paintParentsDark(wv);

        // In debug builds, accept self-signed certificates so the HTTPS
        // dev server (used by `task dev:mobile`) works in the WebView.
        if (BuildConfig.DEBUG) {
            wv.setWebViewClient(
                new com.getcapacitor.BridgeWebViewClient(getBridge()) {
                    @Override
                    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                        handler.proceed();
                    }
                }
            );
        }
    }

    /** Walk up from the WebView and set every parent's background to dark. */
    private void paintParentsDark(View child) {
        ViewGroup parent = (ViewGroup) child.getParent();
        while (parent != null) {
            parent.setBackgroundColor(BG);
            if (parent.getParent() instanceof ViewGroup) {
                parent = (ViewGroup) parent.getParent();
            } else {
                break;
            }
        }
    }
}
