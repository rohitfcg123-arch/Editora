# Editora — PDF Editor

**Tagline:** Edit. Perfect. Export.

Editora is a local-first, browser-based PDF editor. The Android app is a thin WebView wrapper around the same hosted website so the interface and web features stay in sync.

## Current preview features

- Open and preview PDF files in the browser.
- Add text overlays.
- Visually cover a page region and place replacement text.
- Highlight, draw and add signature strokes.
- Add PNG/JPEG images.
- Rotate and mark pages for deletion.
- Extract the current page and merge multiple PDFs.
- Export a new edited PDF copy.
- Responsive website UI and PWA manifest/service worker.

### PDF text editing limitation

The first version adds edit layers to the PDF. **Cover & replace** visually covers a selected region and places new text on top; it does not remove or rewrite the original text objects or redact their underlying content. Do not rely on this tool for secure redaction of sensitive information. Scanned PDFs and protected PDFs may need additional OCR/password handling.

## Publish the website with GitHub Pages

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select branch **main** and folder **root**, then Save.
4. Wait for the Pages deployment to finish.

Expected site URL: https://rohitfcg123-arch.github.io/Editora/

The app uses PDF.js and pdf-lib from public CDNs, so an internet connection is currently required to load these PDF libraries. PDFs opened by the editor are processed in the browser; this version does not upload them to an Editora server.

## Build the Android WebView app

Open the android-app folder in Android Studio. The app loads the same GitHub Pages URL configured in MainActivity.kt. **Enable GitHub Pages first** so the URL is available. Then build a debug APK via **Build → Build APK(s)**.

Because the app loads the hosted website, code/interface updates can appear in the app without building a new APK, provided the WebView/browser cache is refreshed. Changes to native Android code do require rebuilding the APK.

## Firebase rules

firestore.rules, storage.rules, and firebase.json are included as secure deny-by-default templates. No Firebase project has been linked or rules deployed from this repository. The current PDF editing features do not need Firebase. If cloud accounts or cloud documents are added later, implement authentication and user-owned document paths before relaxing these rules.

To deploy the current rules from a local machine with Firebase CLI configured for the intended project:

    firebase use <your-project-id>
    firebase deploy --only firestore:rules,storage

Do not add private API keys or service-account credentials to this public repository.

## Download a debug APK from GitHub Actions

1. Open the repository's **Actions** tab.
2. Open the latest **Build Editora Android APK** run and wait for the green check.
3. In **Artifacts**, download `editora-android-debug-apk`.
4. Extract the ZIP and install `app-debug.apk` on your Android phone. Android may ask you to allow installs from the browser/file manager.

The APK is a WebView shell, not an offline native PDF engine. It needs the GitHub Pages site and internet access to load the shared editor.
