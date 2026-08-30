/* ============================================================
   i18n for the Electron shell (main process).
   ------------------------------------------------------------
   The dashboard and the bundled editor translate themselves in the
   renderer through carino-lang.js + their own i18n.js. That machinery
   cannot reach the shell: the first-run dialog, the tray menu and the
   engine-failed page are all drawn before (or outside) any served page,
   so they have no cookie, no localStorage and no DOM to hook.

   This module is the shell's own tiny dictionary. It resolves once from
   `app.getLocale()` — Electron fixes the locale at launch, so there is
   nothing to re-render — using the same five languages and the same
   prefix matching as carino-lang.js. English source strings are the
   keys, so a missing entry falls back to English exactly as elsewhere.
   ============================================================ */
"use strict";

const STRINGS = {
    es: {
        // First-run data folder
        'Carino DICOM — choose data folder': 'Carino DICOM — elige la carpeta de datos',
        'Where should Carino DICOM store its data?': '¿Dónde debe guardar Carino DICOM sus datos?',
        'Received images, the outgoing queue and logs are saved here:\n\n{dir}\n\nUse this default, or choose another folder.': 'Aquí se guardan las imágenes recibidas, la cola de salida y los registros:\n\n{dir}\n\nUsa esta carpeta predeterminada o elige otra.',
        'Use default': 'Usar la predeterminada',
        'Choose another…': 'Elegir otra…',
        'Quit': 'Salir',
        'Choose the Carino DICOM data folder': 'Elige la carpeta de datos de Carino DICOM',
        'Use this folder': 'Usar esta carpeta',
        // Engine-failed page
        "Carino DICOM couldn't start": 'Carino DICOM no pudo iniciarse',
        'Details were written to:': 'Los detalles se escribieron en:',
        // Tray
        'Open Carino DICOM': 'Abrir Carino DICOM',
        'Start at login': 'Iniciar al arrancar sesión',
        'Quit Carino DICOM': 'Salir de Carino DICOM',
        'Carino DICOM — DICOM store': 'Carino DICOM — almacén DICOM',
    },
    'pt-BR': {
        'Carino DICOM — choose data folder': 'Carino DICOM — escolha a pasta de dados',
        'Where should Carino DICOM store its data?': 'Onde o Carino DICOM deve guardar seus dados?',
        'Received images, the outgoing queue and logs are saved here:\n\n{dir}\n\nUse this default, or choose another folder.': 'As imagens recebidas, a fila de saída e os registros são salvos aqui:\n\n{dir}\n\nUse este padrão ou escolha outra pasta.',
        'Use default': 'Usar o padrão',
        'Choose another…': 'Escolher outra…',
        'Quit': 'Sair',
        'Choose the Carino DICOM data folder': 'Escolha a pasta de dados do Carino DICOM',
        'Use this folder': 'Usar esta pasta',
        "Carino DICOM couldn't start": 'O Carino DICOM não conseguiu iniciar',
        'Details were written to:': 'Os detalhes foram gravados em:',
        'Open Carino DICOM': 'Abrir o Carino DICOM',
        'Start at login': 'Iniciar ao fazer login',
        'Quit Carino DICOM': 'Sair do Carino DICOM',
        'Carino DICOM — DICOM store': 'Carino DICOM — repositório DICOM',
    },
    ja: {
        'Carino DICOM — choose data folder': 'Carino DICOM — データフォルダの選択',
        'Where should Carino DICOM store its data?': 'Carino DICOM のデータをどこに保存しますか？',
        'Received images, the outgoing queue and logs are saved here:\n\n{dir}\n\nUse this default, or choose another folder.': '受信した画像・送信キュー・ログはここに保存されます:\n\n{dir}\n\nこの既定の場所を使うか、別のフォルダを選んでください。',
        'Use default': '既定の場所を使う',
        'Choose another…': '別の場所を選ぶ…',
        'Quit': '終了',
        'Choose the Carino DICOM data folder': 'Carino DICOM のデータフォルダを選択',
        'Use this folder': 'このフォルダを使う',
        "Carino DICOM couldn't start": 'Carino DICOM を起動できませんでした',
        'Details were written to:': '詳細の書き出し先:',
        'Open Carino DICOM': 'Carino DICOM を開く',
        'Start at login': 'ログイン時に起動',
        'Quit Carino DICOM': 'Carino DICOM を終了',
        'Carino DICOM — DICOM store': 'Carino DICOM — DICOMストレージ',
    },
    ru: {
        'Carino DICOM — choose data folder': 'Carino DICOM — выбор папки данных',
        'Where should Carino DICOM store its data?': 'Где Carino DICOM должен хранить свои данные?',
        'Received images, the outgoing queue and logs are saved here:\n\n{dir}\n\nUse this default, or choose another folder.': 'Здесь сохраняются принятые изображения, очередь отправки и журналы:\n\n{dir}\n\nОставьте папку по умолчанию или выберите другую.',
        'Use default': 'Оставить по умолчанию',
        'Choose another…': 'Выбрать другую…',
        'Quit': 'Выйти',
        'Choose the Carino DICOM data folder': 'Выберите папку данных Carino DICOM',
        'Use this folder': 'Использовать эту папку',
        "Carino DICOM couldn't start": 'Не удалось запустить Carino DICOM',
        'Details were written to:': 'Подробности записаны в:',
        'Open Carino DICOM': 'Открыть Carino DICOM',
        'Start at login': 'Запускать при входе в систему',
        'Quit Carino DICOM': 'Выйти из Carino DICOM',
        'Carino DICOM — DICOM store': 'Carino DICOM — хранилище DICOM',
    },
};

// Same prefix matching as carino-lang.js, so the shell and the dashboard
// agree on what "pt-PT" or "es-MX" resolve to.
function resolve(tag) {
    const l = String(tag || '').toLowerCase();
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('pt')) return 'pt-BR';
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('ru')) return 'ru';
    return 'en';
}

let dict = null;

// `app` is passed in rather than required, so this module stays testable and
// does not pull Electron in when it is only being linted.
function init(app) {
    let tag = '';
    try { tag = app.getLocale(); } catch (e) { /* pre-ready: stay English */ }
    dict = STRINGS[resolve(tag)] || null;
}

function t(key, vals) {
    const s = (dict && dict[key]) || key;
    return vals ? s.replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null ? vals[k] : m)) : s;
}

module.exports = { init, t, resolve };
