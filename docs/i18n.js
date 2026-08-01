// i18n — Carino PACS landing page. Fleet convention (see Topo/js/i18n.js):
// English source strings ARE the keys, so a missing entry falls back to
// English. Locale comes from carino-lang.js (window.CarinoLang.current);
// this script must load deferred, AFTER carino-lang.js.
// I18N = flat text for [data-i18n] leaves; RICH = per-selector innerHTML for
// paragraphs that mix text with <strong>/<em>/<code>/<a> children.

const I18N = {
    es: {
        // Hero
        'Your PACS systems are down? Urgent patients cannot wait.': '¿Tu PACS está caído? Los pacientes urgentes no pueden esperar.',
        'Send & receive medical images,': 'Envía y recibe imágenes médicas,',
        'without the headache.': 'sin dolores de cabeza.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Buscando la última versión…',
        // First-run help
        "First launch shows a security warning? Here's how to open it": '¿La primera vez aparece una advertencia de seguridad? Así se abre',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'La advertencia aparece porque la app aún no está firmada digitalmente; es segura.',
        // Two jobs
        "Two jobs. That's it.": 'Dos tareas. Nada más.',
        '📥 Receives': '📥 Recibe',
        '— machines and scanners send images to your computer; it files them into tidy folders by patient and study.': '— los equipos y escáneres envían imágenes a tu computadora, y las organiza en carpetas ordenadas por paciente y estudio.',
        '📤 Forwards': '📤 Reenvía',
        '— watches a folder and automatically sends new images on to the systems you pick, retrying until each one has it.': '— vigila una carpeta y envía automáticamente las imágenes nuevas a los sistemas que elijas, reintentando hasta que cada uno las reciba.',
        // 3 steps
        'Up and running in 3 steps': 'Listo en 3 pasos',
        'Open it — it tucks into your system tray and keeps running.': 'Ábrelo: se queda en la bandeja del sistema y sigue funcionando.',
        'Click the tray icon — a simple dashboard opens.': 'Haz clic en el icono de la bandeja: se abre un panel sencillo.',
        'Pick a folder, add where to send. Done.': 'Elige una carpeta, añade a dónde enviar. Listo.',
        // Tech box
        'For technical users': 'Para usuarios técnicos',
        '— DICOM details, CLI & source': '— detalles DICOM, CLI y código fuente',
        'Build & release': 'Compilación y release',
        // Footer
        'Deliberately simple, not an enterprise PACS. Not a medical device — use TLS and restrict access before touching real patient data.': 'Deliberadamente simple, no un PACS empresarial. No es un producto sanitario: usa TLS y restringe el acceso antes de tocar datos reales de pacientes.',
        // JS-generated (app.js version line)
        'Latest release:': 'Última versión:',
        'Latest release': 'La última versión',
        'has no installers yet —': 'aún no tiene instaladores;',
        'all versions & notes': 'todas las versiones y notas',
        'see releases': 'ver releases',
        'Version': 'Versión',
    },
    'pt-BR': {
        'Your PACS systems are down? Urgent patients cannot wait.': 'Seu PACS caiu? Pacientes urgentes não podem esperar.',
        'Send & receive medical images,': 'Envie e receba imagens médicas,',
        'without the headache.': 'sem dor de cabeça.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Verificando a versão mais recente…',
        "First launch shows a security warning? Here's how to open it": 'Apareceu um aviso de segurança na primeira execução? Veja como abrir',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'O aviso aparece porque o app ainda não é assinado digitalmente; ele é seguro.',
        "Two jobs. That's it.": 'Duas tarefas. Só isso.',
        '📥 Receives': '📥 Recebe',
        '— machines and scanners send images to your computer; it files them into tidy folders by patient and study.': '— os equipamentos e scanners enviam imagens para o seu computador, e ele as organiza em pastas por paciente e estudo.',
        '📤 Forwards': '📤 Encaminha',
        '— watches a folder and automatically sends new images on to the systems you pick, retrying until each one has it.': '— monitora uma pasta e envia automaticamente as novas imagens para os sistemas que você escolher, tentando de novo até cada um recebê-las.',
        'Up and running in 3 steps': 'Funcionando em 3 passos',
        'Open it — it tucks into your system tray and keeps running.': 'Abra o app: ele fica na bandeja do sistema e continua rodando.',
        'Click the tray icon — a simple dashboard opens.': 'Clique no ícone da bandeja: um painel simples se abre.',
        'Pick a folder, add where to send. Done.': 'Escolha uma pasta, adicione para onde enviar. Pronto.',
        'For technical users': 'Para usuários técnicos',
        '— DICOM details, CLI & source': '— detalhes DICOM, CLI e código-fonte',
        'Build & release': 'Build e release',
        'Deliberately simple, not an enterprise PACS. Not a medical device — use TLS and restrict access before touching real patient data.': 'Deliberadamente simples, não é um PACS corporativo. Não é um dispositivo médico: use TLS e restrinja o acesso antes de lidar com dados reais de pacientes.',
        'Latest release:': 'Versão mais recente:',
        'Latest release': 'A versão mais recente',
        'has no installers yet —': 'ainda não tem instaladores;',
        'all versions & notes': 'todas as versões e notas',
        'see releases': 'ver releases',
        'Version': 'Versão',
    },
    ja: {
        'Your PACS systems are down? Urgent patients cannot wait.': 'PACSがダウン？急患は待ってくれません。',
        'Send & receive medical images,': '医用画像の送受信を、',
        'without the headache.': '面倒なしで。',
        'recommended': '推奨',
        'Checking for the latest version…': '最新バージョンを確認中…',
        "First launch shows a security warning? Here's how to open it": '初回起動でセキュリティ警告が出る？開き方はこちら',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'この警告はアプリがまだコード署名されていないためです。安全です。',
        "Two jobs. That's it.": '仕事は2つだけ。',
        '📥 Receives': '📥 受信',
        '— machines and scanners send images to your computer; it files them into tidy folders by patient and study.': '— 装置やスキャナーからPCに画像が送られ、患者・検査ごとにフォルダへ整理されます。',
        '📤 Forwards': '📤 転送',
        '— watches a folder and automatically sends new images on to the systems you pick, retrying until each one has it.': '— フォルダを監視し、新しい画像を指定したシステムへ自動送信。すべてに届くまで再試行します。',
        'Up and running in 3 steps': '3ステップで使い始める',
        'Open it — it tucks into your system tray and keeps running.': '起動する — システムトレイに常駐して動き続けます。',
        'Click the tray icon — a simple dashboard opens.': 'トレイアイコンをクリック — シンプルなダッシュボードが開きます。',
        'Pick a folder, add where to send. Done.': 'フォルダを選び、送信先を追加。以上です。',
        'For technical users': '技術者向け',
        '— DICOM details, CLI & source': '— DICOMの詳細・CLI・ソース',
        'Build & release': 'ビルドとリリース',
        'Deliberately simple, not an enterprise PACS. Not a medical device — use TLS and restrict access before touching real patient data.': '意図的にシンプルであり、エンタープライズPACSではありません。医療機器でもありません。実際の患者データを扱う前にTLSを使用し、アクセスを制限してください。',
        'Latest release:': '最新リリース:',
        'Latest release': '最新リリース',
        'has no installers yet —': 'にはまだインストーラーがありません —',
        'all versions & notes': '全バージョンとリリースノート',
        'see releases': 'リリース一覧を見る',
        'Version': 'バージョン',
    },
    ru: {
        'Your PACS systems are down? Urgent patients cannot wait.': 'PACS не работает? Экстренные пациенты не могут ждать.',
        'Send & receive medical images,': 'Отправляйте и получайте медицинские изображения,',
        'without the headache.': 'без головной боли.',
        'recommended': 'рекомендуется',
        'Checking for the latest version…': 'Проверяем последнюю версию…',
        "First launch shows a security warning? Here's how to open it": 'При первом запуске появляется предупреждение безопасности? Вот как открыть',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'Предупреждение появляется потому, что приложение ещё не имеет цифровой подписи — оно безопасно.',
        "Two jobs. That's it.": 'Две задачи. И всё.',
        '📥 Receives': '📥 Приём',
        '— machines and scanners send images to your computer; it files them into tidy folders by patient and study.': '— аппараты и сканеры отправляют изображения на ваш компьютер, а он раскладывает их по аккуратным папкам по пациентам и исследованиям.',
        '📤 Forwards': '📤 Пересылка',
        '— watches a folder and automatically sends new images on to the systems you pick, retrying until each one has it.': '— следит за папкой и автоматически отправляет новые изображения в выбранные системы, повторяя попытки, пока каждая их не получит.',
        'Up and running in 3 steps': 'Запуск за 3 шага',
        'Open it — it tucks into your system tray and keeps running.': 'Откройте его — он свернётся в системный трей и продолжит работать.',
        'Click the tray icon — a simple dashboard opens.': 'Нажмите на значок в трее — откроется простая панель.',
        'Pick a folder, add where to send. Done.': 'Выберите папку, добавьте адресатов. Готово.',
        'For technical users': 'Для технических специалистов',
        '— DICOM details, CLI & source': '— детали DICOM, CLI и исходный код',
        'Build & release': 'Сборка и релиз',
        'Deliberately simple, not an enterprise PACS. Not a medical device — use TLS and restrict access before touching real patient data.': 'Намеренно простой, не корпоративный PACS. Не медицинское изделие — используйте TLS и ограничьте доступ, прежде чем работать с реальными данными пациентов.',
        'Latest release:': 'Последний релиз:',
        'Latest release': 'Последний релиз',
        'has no installers yet —': 'пока без установщиков —',
        'all versions & notes': 'все версии и заметки',
        'see releases': 'смотреть релизы',
        'Version': 'Версия',
    },
};

// Rich blocks: paragraphs/list items mixing text with inline children.
// Keyed by CSS selector; values are full innerHTML per locale (en = original
// markup, restored from a snapshot captured on first pass). Inline tags and
// links mirror the English markup exactly.
const RICH = {
    '.lede': {
        es: '<strong>Carino PACS</strong> recibe silenciosamente imágenes <abbr title="el formato estándar de las imágenes médicas de los escáneres: rayos X, TC, RM, ecografía…">DICOM</abbr> y las reenvía automáticamente a donde las necesites. Hace dos cosas bien — <em>no</em> es un PACS empresarial, y esa es la gracia. Descárgalo y listo.',
        'pt-BR': '<strong>Carino PACS</strong> recebe silenciosamente imagens <abbr title="o formato padrão das imagens médicas dos scanners: raio-X, TC, RM, ultrassom…">DICOM</abbr> e as encaminha automaticamente para onde você precisar. Ele faz duas coisas bem — <em>não</em> é um PACS corporativo, e essa é a ideia. Baixe e use.',
        ja: '<strong>Carino PACS</strong> は<abbr title="X線・CT・MRI・超音波などの医用画像の標準フォーマット">DICOM</abbr>画像を静かに受信し、必要な場所へ自動転送します。得意なことは2つだけ — エンタープライズPACSでは<em>ありません</em>。それがポイントです。ダウンロードしてすぐ使えます。',
        ru: '<strong>Carino PACS</strong> незаметно принимает <abbr title="стандартный формат медицинских изображений со сканеров: рентген, КТ, МРТ, УЗИ…">DICOM</abbr>-изображения и автоматически пересылает их туда, куда нужно. Он хорошо делает две вещи — это <em>не</em> корпоративный PACS, и в этом суть. Скачайте и работайте.',
    },
    '#fr-win': {
        es: '<strong>Windows:</strong> <em>Más información</em> → <em>Ejecutar de todas formas</em>.',
        'pt-BR': '<strong>Windows:</strong> <em>Mais informações</em> → <em>Executar assim mesmo</em>.',
        ja: '<strong>Windows:</strong> <em>詳細情報</em> → <em>実行</em>。',
        ru: '<strong>Windows:</strong> <em>Подробнее</em> → <em>Выполнить в любом случае</em>.',
    },
    '#fr-mac': {
        es: '<strong>macOS:</strong> clic derecho en la app → <em>Abrir</em> → <em>Abrir</em>. Si dice <em>«está dañada y no se puede abrir»</em>, quita la cuarentena de descarga: <code>xattr -dr com.apple.quarantine /Applications/Carino-PACS.app</code>',
        'pt-BR': '<strong>macOS:</strong> clique com o botão direito no app → <em>Abrir</em> → <em>Abrir</em>. Se disser <em>"está danificado e não pode ser aberto"</em>, remova a quarentena do download: <code>xattr -dr com.apple.quarantine /Applications/Carino-PACS.app</code>',
        ja: '<strong>macOS:</strong> アプリを右クリック → <em>開く</em> → <em>開く</em>。<em>「壊れているため開けません」</em>と表示される場合は、ダウンロードの隔離属性を解除してください: <code>xattr -dr com.apple.quarantine /Applications/Carino-PACS.app</code>',
        ru: '<strong>macOS:</strong> щёлкните приложение правой кнопкой → <em>Открыть</em> → <em>Открыть</em>. Если пишет <em>«повреждено и не может быть открыто»</em>, снимите карантин загрузки: <code>xattr -dr com.apple.quarantine /Applications/Carino-PACS.app</code>',
    },
    '#fr-linux': {
        es: '<strong>Linux:</strong> lo más fácil es el <code>.rpm</code> (Fedora/RHEL) o el <code>.deb</code> (Debian/Ubuntu) de los <a href="https://github.com/MiguelCarino/Carino-PACS/releases" target="_blank" rel="noopener">releases</a>. El <code>.AppImage</code> necesita FUSE — <code>sudo dnf install fuse-libs</code> (Fedora) / <code>sudo apt install libfuse2</code> (Debian), o ejecútalo con <code>--appimage-extract-and-run</code>.',
        'pt-BR': '<strong>Linux:</strong> o mais fácil é o <code>.rpm</code> (Fedora/RHEL) ou o <code>.deb</code> (Debian/Ubuntu) dos <a href="https://github.com/MiguelCarino/Carino-PACS/releases" target="_blank" rel="noopener">releases</a>. O <code>.AppImage</code> precisa de FUSE — <code>sudo dnf install fuse-libs</code> (Fedora) / <code>sudo apt install libfuse2</code> (Debian), ou execute com <code>--appimage-extract-and-run</code>.',
        ja: '<strong>Linux:</strong> 一番簡単なのは<a href="https://github.com/MiguelCarino/Carino-PACS/releases" target="_blank" rel="noopener">リリース</a>の<code>.rpm</code>（Fedora/RHEL）または<code>.deb</code>（Debian/Ubuntu）です。<code>.AppImage</code>にはFUSEが必要 — <code>sudo dnf install fuse-libs</code>（Fedora）/ <code>sudo apt install libfuse2</code>（Debian）、または<code>--appimage-extract-and-run</code>を付けて実行してください。',
        ru: '<strong>Linux:</strong> проще всего <code>.rpm</code> (Fedora/RHEL) или <code>.deb</code> (Debian/Ubuntu) со страницы <a href="https://github.com/MiguelCarino/Carino-PACS/releases" target="_blank" rel="noopener">релизов</a>. Для <code>.AppImage</code> нужен FUSE — <code>sudo dnf install fuse-libs</code> (Fedora) / <code>sudo apt install libfuse2</code> (Debian), либо запустите с <code>--appimage-extract-and-run</code>.',
    },
    '#tech-intro': {
        es: 'Un PACS solo de almacenamiento construido sobre <code>pynetdicom</code>/<code>pydicom</code>; la app de escritorio es un shell de bandeja en Electron sobre el mismo motor.',
        'pt-BR': 'Um PACS somente de armazenamento construído sobre <code>pynetdicom</code>/<code>pydicom</code>; o app de desktop é um shell de bandeja em Electron sobre o mesmo motor.',
        ja: '<code>pynetdicom</code>/<code>pydicom</code>ベースのストア専用PACS。デスクトップアプリは同じエンジンをElectronのトレイシェルで包んだものです。',
        ru: 'PACS только для хранения на базе <code>pynetdicom</code>/<code>pydicom</code>; настольное приложение — Electron-оболочка в трее вокруг того же движка.',
    },
    '#tl-scp': {
        es: '<b>Storage SCP</b> — C-STORE + C-ECHO, archiva por Paciente/Estudio/Serie, todas las sintaxis de transferencia (lo comprimido se guarda tal cual).',
        'pt-BR': '<b>Storage SCP</b> — C-STORE + C-ECHO, arquiva por Paciente/Estudo/Série, todas as sintaxes de transferência (comprimidos são guardados como estão).',
        ja: '<b>Storage SCP</b> — C-STORE + C-ECHO。患者/検査/シリーズ別に保存、全転送構文に対応（圧縮データはそのまま保存）。',
        ru: '<b>Storage SCP</b> — C-STORE + C-ECHO, раскладка по схеме Пациент/Исследование/Серия, все синтаксисы передачи (сжатые хранятся как есть).',
    },
    '#tl-scu': {
        es: '<b>Storage SCU</b> — reenvío automático por vigilancia de carpeta a N nodos, reintentos por destino, conservar/mover/borrar al completar.',
        'pt-BR': '<b>Storage SCU</b> — encaminhamento automático por monitoramento de pasta para N nós, novas tentativas por destino, manter/mover/excluir ao concluir.',
        ja: '<b>Storage SCU</b> — フォルダ監視でN個のノードへ自動転送。宛先ごとの再試行、成功時に保持/移動/削除。',
        ru: '<b>Storage SCU</b> — автопересылка из отслеживаемой папки на N узлов, повторы по каждому адресату, сохранить/переместить/удалить после успеха.',
    },
    '#tl-tls': {
        es: '<b>DICOM-TLS</b> en ambos lados (opcional), incl. TLS mutuo.',
        'pt-BR': '<b>DICOM-TLS</b> dos dois lados (opcional), incl. TLS mútuo.',
        ja: '<b>DICOM-TLS</b> 送受信の両側で対応（オプション）。相互TLSにも対応。',
        ru: '<b>DICOM-TLS</b> с обеих сторон (опционально), включая взаимный TLS.',
    },
    '#tl-ui': {
        es: 'Panel web, CLI sin interfaz (<code>pacs serve|receive|send|echo</code>) o app de bandeja. Puerto DICOM <code>11112</code>; panel en <code>127.0.0.1:8042</code>.',
        'pt-BR': 'Painel web, CLI headless (<code>pacs serve|receive|send|echo</code>) ou app de bandeja. Porta DICOM <code>11112</code>; painel em <code>127.0.0.1:8042</code>.',
        ja: 'Webダッシュボード、ヘッドレスCLI（<code>pacs serve|receive|send|echo</code>）、またはトレイアプリ。DICOMポートは<code>11112</code>、ダッシュボードは<code>127.0.0.1:8042</code>。',
        ru: 'Веб-панель, headless CLI (<code>pacs serve|receive|send|echo</code>) или приложение в трее. DICOM-порт <code>11112</code>; панель — <code>127.0.0.1:8042</code>.',
    },
};

let LOCALE = 'en';

function currentFleetLang() { return (window.CarinoLang && window.CarinoLang.current) || 'en'; }

function setLocale(l) {
    LOCALE = (l === 'en' || I18N[l]) ? l : 'en';
    document.documentElement.lang = LOCALE;
}

function t(key) {
    const dict = I18N[LOCALE];
    return (dict && dict[key]) || key;
}

// Static markup: elements carrying data-i18n use their original English text
// as the key (captured on first pass so locale switches stay reversible).
function applyStaticI18n() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        if (!el.dataset.i18nKey) el.dataset.i18nKey = el.textContent.trim();
        el.textContent = t(el.dataset.i18nKey);
    });
}

// Rich blocks: snapshot the original English innerHTML once, then swap the
// whole innerHTML per locale (en restores the snapshot).
function applyRichI18n() {
    Object.keys(RICH).forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        if (el.dataset.i18nRich === undefined) el.dataset.i18nRich = el.innerHTML;
        el.innerHTML = RICH[sel][LOCALE] || el.dataset.i18nRich;
    });
}

// The #version line is rewritten async by app.js (GitHub API). Translate the
// placeholder only while it still shows the placeholder (in any language) —
// never clobber the fetched release info on a later language switch.
function applyVersionPlaceholder() {
    const KEY = 'Checking for the latest version…';
    const el = document.getElementById('version');
    if (!el) return;
    const cur = el.textContent.trim();
    const isPlaceholder = cur === KEY ||
        Object.keys(I18N).some((l) => I18N[l][KEY] === cur);
    if (isPlaceholder) el.textContent = t(KEY);
}

function applyAll() {
    setLocale(currentFleetLang());
    applyStaticI18n();
    applyRichI18n();
    applyVersionPlaceholder();
}

// carino-lang.js is deferred and runs before this (also deferred, later in
// the document), so CarinoLang exists here. Set the locale immediately so
// app.js's async callbacks pick the right language via window.t.
setLocale(currentFleetLang());
document.addEventListener('DOMContentLoaded', applyAll);
window.addEventListener('carino:langchange', applyAll);
