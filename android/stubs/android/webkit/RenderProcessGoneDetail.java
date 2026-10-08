// Compile-time stand-in for the Android 8.0 (API 26) class, so MainActivity can override
// WebViewClient#onRenderProcessGone while compiling against the API 23 platform. Never packaged: on a phone the
// real class is used, and older versions never call the method.
package android.webkit;

public abstract class RenderProcessGoneDetail {
    public abstract boolean didCrash();

    public abstract int rendererPriorityAtExit();
}
