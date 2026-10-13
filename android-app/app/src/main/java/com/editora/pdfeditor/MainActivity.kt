package com.editora.pdfeditor

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import android.content.Context
import android.util.Base64
import android.os.Handler
import android.os.Looper
import java.io.IOException

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileRequestCode = 721
    private val siteUrl = "https://rohitfcg123-arch.github.io/Editora/"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.statusBarColor = Color.rgb(17, 24, 39)
        window.navigationBarColor = Color.rgb(17, 24, 39)

        val root = FrameLayout(this)
        root.setBackgroundColor(Color.rgb(245, 247, 251))
        webView = WebView(this)
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal)
        progressBar.max = 100
        progressBar.progress = 5
        progressBar.visibility = View.VISIBLE

        root.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        val barParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            dp(3)
        )
        root.addView(progressBar, barParams)
        setContentView(root)

        webView.setBackgroundColor(Color.rgb(245, 247, 251))
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
        }

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.addJavascriptInterface(DownloadBridge(this), "EditoraNative")

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    val accept = fileChooserParams?.acceptTypes
                        ?.flatMap { it.split(",") }
                        ?.map { it.trim() }
                        ?.filter { it.isNotBlank() }
                        ?.distinct()
                        ?: emptyList()
                    type = when {
                        accept.size == 1 -> accept.first()
                        accept.isNotEmpty() -> "*/*"
                        else -> "*/*"
                    }
                    if (accept.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, accept.toTypedArray())
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }

                return try {
                    startActivityForResult(intent, fileRequestCode)
                    true
                } catch (error: Exception) {
                    this@MainActivity.filePathCallback = null
                    Toast.makeText(this@MainActivity, "No file picker is available.", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return false
                if (uri.scheme == "https" && uri.host == "rohitfcg123-arch.github.io" &&
                    (uri.path ?: "").startsWith("/Editora/")) {
                    return false
                }
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    true
                } catch (_: Exception) {
                    true
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    Toast.makeText(this@MainActivity, "Editora could not load. Check your internet or GitHub Pages settings.", Toast.LENGTH_LONG).show()
                }
            }
        }

        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            // Standard HTTPS downloads are delegated to Android. Blob downloads are
            // saved through EditoraNative.saveBase64File from the shared web code.
            if (url.startsWith("https://")) {
                try {
                    val request = DownloadManager.Request(Uri.parse(url))
                        .setTitle("Editora download")
                        .setDescription("Saving your document")
                        .setMimeType(mimeType ?: "application/pdf")
                        .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Editora-document.pdf")
                    val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                    manager.enqueue(request)
                    Toast.makeText(this, "Downloading to Downloads.", Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {
                    Toast.makeText(this, "Could not start download.", Toast.LENGTH_LONG).show()
                }
            }
        })

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(siteUrl)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    @Deprecated("Use Activity Result API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == fileRequestCode) {
            val result: Array<Uri>? = if (resultCode == RESULT_OK) {
                data?.data?.let { arrayOf(it) }
            } else null
            filePathCallback?.onReceiveValue(result)
            filePathCallback = null
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Use OnBackPressedDispatcher")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.removeJavascriptInterface("EditoraNative")
            webView.destroy()
        }
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        super.onDestroy()
    }

    private class DownloadBridge(private val activity: MainActivity) {
        @JavascriptInterface
        fun saveBase64File(name: String, mimeType: String, base64: String) {
            Thread {
                var resultMessage = "Could not save the file."
                try {
                    val safeName = name.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(100)
                        .ifBlank { "Editora-document.pdf" }
                    val cleanMime = mimeType.takeIf { it.contains("/") } ?: "application/pdf"
                    val bytes = Base64.decode(base64, Base64.DEFAULT)
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, cleanMime)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Editora")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val resolver = activity.contentResolver
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IOException("Could not create the download file.")
                    resolver.openOutputStream(uri)?.use { stream -> stream.write(bytes) }
                        ?: throw IOException("Could not write the download.")
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    resultMessage = "Saved to Downloads/Editora."
                } catch (error: Exception) {
                    resultMessage = "Save failed: " + (error.message ?: "unknown error")
                }
                Handler(Looper.getMainLooper()).post {
                    Toast.makeText(activity, resultMessage, Toast.LENGTH_LONG).show()
                }
            }.start()
        }
    }
}
