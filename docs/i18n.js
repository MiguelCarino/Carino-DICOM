// i18n — Carino PACS landing page. Fleet convention (see Topo/js/i18n.js):
// English source strings ARE the keys, so a missing entry falls back to
// English. Locale comes from carino-lang.js (window.CarinoLang.current);
// this script must load deferred, AFTER carino-lang.js.
// I18N = flat text for [data-i18n] leaves; RICH = per-selector innerHTML for
// paragraphs that mix text with <strong>/<em>/<code>/<a> children.
//
// Protocol identifiers are NOT translated in any locale — Storage SCP, MWL,
// C-STORE, C-FIND, C-MOVE, DICOMweb, QIDO-RS, WADO-RS, STOW-RS, MLLP, TLS.
// Those are the words the reader's modality manual uses; translating them
// costs a reader the ability to match a screen to a spec sheet.

const I18N = {
    es: {
        'Late shift.': 'Turno nocturno.',
        'Good morning.': 'Buenos días.',
        'Good afternoon.': 'Buenas tardes.',
        'Good evening.': 'Buenas noches.',
        // Hero
        'Your PACS systems are down?': '¿Tu PACS está caído?',
        'Urgent patients cannot wait.': 'Los pacientes urgentes no pueden esperar.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Buscando la última versión…',
        // First-run help
        "First launch shows a security warning? Here's how to open it": '¿La primera vez aparece una advertencia de seguridad? Así se abre',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'La advertencia aparece porque la app aún no está firmada digitalmente; es segura.',
        // Server quick start
        // What it does
        '📥 Receive and file': '📥 Recibe y archiva',
        'A Storage SCP that accepts C-STORE and C-ECHO and files each study to disk by patient, study and series. Compressed objects are stored exactly as they arrived — never transcoded.': 'Un Storage SCP que acepta C-STORE y C-ECHO y guarda cada estudio en disco por paciente, estudio y serie. Los objetos comprimidos se almacenan tal como llegaron: nunca se transcodifican.',
        '📤 Route and forward': '📤 Enruta y reenvía',
        'Forwards to as many nodes as you like, with rules: CT from the ER to the archive, ultrasound to the reading room. Each destination is retried until it accepts. A file that matches no rule goes everywhere rather than nowhere.': 'Reenvía a tantos nodos como quieras, con reglas: la TC de urgencias al archivo, el ultrasonido a la sala de lectura. Cada destino se reintenta hasta que acepta. Un archivo que no coincide con ninguna regla va a todos los destinos, no a ninguno.',
        '🕶️ De-identify on the way out': '🕶️ Anonimiza al salir',
        'A rule can de-identify the copy it sends (PS3.15 Basic profile) while the archived original stays untouched. It does not clean burned-in pixel text — a human still has to look at the images.': 'Una regla puede anonimizar la copia que envía (perfil básico de PS3.15) mientras el original archivado queda intacto. No limpia el texto grabado en los píxeles: alguien tiene que mirar las imágenes.',
        'C-FIND, C-MOVE and C-GET over an indexed view of what is actually on disk, so a twelve-year-old ultrasound or CR reader can ask what you hold and pull it back.': 'C-FIND, C-MOVE y C-GET sobre un índice de lo que hay realmente en disco, para que un ecógrafo o un lector de CR de hace doce años pueda preguntar qué tienes y traérselo.',
        'QIDO-RS, WADO-RS and STOW-RS, so OHIF, Weasis and other modern viewers can read the archive over HTTP without negotiating a DICOM association.': 'QIDO-RS, WADO-RS y STOW-RS, para que OHIF, Weasis y otros visores modernos lean el archivo por HTTP sin negociar una asociación DICOM.',
        '📋 Worklist and emergency RIS': '📋 Worklist y RIS de emergencia',
        'Takes HL7 orders over MLLP or hand-keyed ones, and serves them to modalities as a Modality Worklist. If your primary PACS stops answering, it can take over, hold what arrives, and forward it once the primary is back.': 'Recibe órdenes HL7 por MLLP —o capturadas a mano— y las sirve a las modalidades como Modality Worklist. Si tu PACS principal deja de responder, puede tomar el relevo, retener lo que llega y reenviarlo cuando el principal vuelve.',
        '🖨️ Virtual print': '🖨️ Impresión virtual',
        'Captures print-only modalities as PDF, so a machine whose only output is film still produces something you can file.': 'Captura como PDF las modalidades que solo saben imprimir, para que un equipo cuya única salida es la placa siga produciendo algo archivable.',
        '🔑 Token authentication': '🔑 Autenticación por token',
        'The dashboard and the DICOMweb API take a single shared token. Bind them to anything other than localhost without one and the server refuses to start — the refusal is the feature.': 'El panel y la API DICOMweb usan un único token compartido. Si los expones fuera de localhost sin token, el servidor se niega a arrancar: esa negativa es la función.',
        // What it is not
        'What it is not': 'Lo que no es',
        'Not a medical device.': 'No es un producto sanitario.',
        'It is not certified, cleared or registered anywhere, and nothing in it has been validated for clinical use by anyone. Whoever deploys it owns that validation.': 'No está certificado, autorizado ni registrado en ningún país, y nada en él ha sido validado para uso clínico por nadie. Quien lo despliega asume esa validación.',
        'Not for primary diagnosis.': 'No sirve para diagnóstico primario.',
        'There is no diagnostic viewer here: no windowing, no measurements, no rendering pipeline. Read studies on the validated workstation you already have.': 'Aquí no hay visor diagnóstico: sin ventaneo, sin mediciones, sin renderizado. Interpreta los estudios en la estación de trabajo validada que ya tienes.',
        'Not an enterprise archive.': 'No es un archivo empresarial.',
        'No high availability, no clustering, no retention policies, and no encryption at rest — put it on an encrypted disk. It has its own profiles and audit trail, but no LDAP, no Active Directory and no single sign-on, so accounts live on the appliance rather than with your identity provider.': 'Sin alta disponibilidad, sin clustering, sin políticas de retención y sin cifrado en reposo: póngalo sobre un disco cifrado. Tiene sus propios perfiles y su propia auditoría, pero no habla LDAP, ni Active Directory, ni inicio de sesión único, así que las cuentas viven en el equipo y no en su proveedor de identidad.',
        'Not a replacement for your PACS or your RIS.': 'No sustituye a tu PACS ni a tu RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Es la pasarela entre ellos y lo que mantiene funcionando al servicio durante una caída, hasta que vuelvan.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Si la atención de un paciente depende de esto, la responsabilidad es tuya, no del software.',
        // 3 steps
        // Tech box
        'For technical users': 'Para usuarios técnicos',
        '— DICOM details, CLI & source': '— detalles DICOM, CLI y código fuente',
        'Security policy': 'Política de seguridad',
        'Build & release': 'Compilación y release',
        // Footer
        // JS-generated (app.js version line)
        'Version': 'Versión',
        'All versions and changelogs →': 'Todas las versiones y changelogs →',
        '📖 Read the manual': '📖 Leer el manual',
        'First launch': 'Primer arranque',
        'What it is (and is not)': 'Qué es (y qué no)',
        'Features': 'Funciones',
        '🖥 Server': '🖥 Servidor',
        'Run it on a server': 'Ejecutarlo en un servidor',
        'No installer for these — all three run the same application. Pick the one your machine already speaks.': 'Para estos no hay instalador: los tres ejecutan la misma aplicación. Elige el que tu máquina ya hable.',
        'Compose file, everything on loopback. The first boot prints an access token — open http://127.0.0.1:8042/ and paste it when the dashboard asks.': 'Archivo compose, todo en loopback. El primer arranque imprime un token de acceso: abre http://127.0.0.1:8042/ y pégalo cuando el panel lo pida.',
        'Rootless, and systemd owns it. Needs no compose provider, and the token prints to the journal on first boot.': 'Sin root, y systemd lo gestiona. No necesita proveedor de compose, y el token se imprime en el journal en el primer arranque.',
        'From source, as a system service with an account of its own. The installer stops before starting it — opening listeners that accept patient data stays your decision.': 'Desde el código, como servicio del sistema con su propia cuenta. El instalador se detiene antes de arrancarlo: abrir puertos que aceptan datos de pacientes sigue siendo tu decisión.',
        'Details →': 'Detalles ↓',
        'Full deployment guide →': 'Guía completa de despliegue →',

        // ── Profiles, audit trail and emergency notification ──
        '👥 People and permissions': '👥 Personas y permisos',
        'Optional per-person sign-in with four editable presets. Permissions are checked at every endpoint, not hidden in the browser, and you choose per profile which patient identifiers each person may see — so IT can trace a study by accession number without reading anyone\'s chart.': 'Inicio de sesión por persona, opcional, con cuatro perfiles predefinidos y editables. Los permisos se comprueban en cada endpoint, no se esconden en el navegador, y usted elige por perfil qué identificadores del paciente ve cada persona: así TI puede seguir un estudio por su número de acceso sin leer la historia de nadie.',
        '🔒 Audit trail': '🔒 Registro de auditoría',
        'Append-only, hash-chained records of who did what, to which study, from where, and whether it worked — refusals included. Any edit or deletion inside the file breaks the chain and the dashboard says which record and why.': 'Registros de solo anexado, encadenados por hash: quién hizo qué, sobre qué estudio, desde dónde y si funcionó, incluidos los intentos denegados. Cualquier edición o borrado dentro del archivo rompe la cadena, y el panel dice en qué registro y por qué.',

        // ── What it is, and which release a capability ships in ──
        'What it is': 'Qué es',
        'A gateway between your equipment and your archive.': 'Una pasarela entre sus equipos y su archivo.',
        'Studies arrive, get routed by rules you write, and are retried until every destination has taken them.': 'Los estudios llegan, se enrutan según reglas que usted escribe y se reintentan hasta que todos los destinos los han aceptado.',
        'A continuity appliance.': 'Un equipo de continuidad.',
        'When the primary PACS stops answering, it serves the worklist itself, holds what arrives, and back-fills once the primary returns.': 'Cuando el PACS principal deja de responder, sirve él mismo la worklist, retiene lo que llega y lo reenvía en cuanto el principal vuelve.',
        'A translator for equipment nothing else will talk to.': 'Un traductor para equipos con los que nada más quiere hablar.',
        'Print-only modalities, consoles with no RIS feed, readers that speak nothing but DIMSE.': 'Equipos que solo imprimen, consolas sin conexión al RIS, lectores que no hablan más que DIMSE.',
        'Yours, on your hardware.': 'Suyo, en su propio hardware.',
        'One config file, one process, no cloud, no telemetry, no licence server. AGPL-3.0.': 'Un archivo de configuración, un proceso, sin nube, sin telemetría, sin servidor de licencias. AGPL-3.0.',
        'Every service is off until you turn it on. The tag on each card is the release it ships in.': 'Cada servicio está apagado hasta que usted lo enciende. La etiqueta de cada tarjeta es la versión en la que sale.',
    },
    'pt-BR': {
        'Late shift.': 'Turno da noite.',
        'Good morning.': 'Bom dia.',
        'Good afternoon.': 'Boa tarde.',
        'Good evening.': 'Boa noite.',
        'Your PACS systems are down?': 'Seu PACS caiu?',
        'Urgent patients cannot wait.': 'Pacientes urgentes não podem esperar.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Verificando a versão mais recente…',
        "First launch shows a security warning? Here's how to open it": 'Apareceu um aviso de segurança na primeira execução? Veja como abrir',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'O aviso aparece porque o app ainda não é assinado digitalmente; ele é seguro.',
        '📥 Receive and file': '📥 Recebe e arquiva',
        'A Storage SCP that accepts C-STORE and C-ECHO and files each study to disk by patient, study and series. Compressed objects are stored exactly as they arrived — never transcoded.': 'Um Storage SCP que aceita C-STORE e C-ECHO e grava cada estudo em disco por paciente, estudo e série. Objetos comprimidos são armazenados exatamente como chegaram — nunca transcodificados.',
        '📤 Route and forward': '📤 Roteia e encaminha',
        'Forwards to as many nodes as you like, with rules: CT from the ER to the archive, ultrasound to the reading room. Each destination is retried until it accepts. A file that matches no rule goes everywhere rather than nowhere.': 'Encaminha para quantos nós você quiser, com regras: a TC do pronto-socorro para o arquivo, o ultrassom para a sala de laudos. Cada destino é retentado até aceitar. Um arquivo que não casa com nenhuma regra vai para todos os destinos, nunca para nenhum.',
        '🕶️ De-identify on the way out': '🕶️ Anonimiza na saída',
        'A rule can de-identify the copy it sends (PS3.15 Basic profile) while the archived original stays untouched. It does not clean burned-in pixel text — a human still has to look at the images.': 'Uma regra pode anonimizar a cópia enviada (perfil básico da PS3.15) enquanto o original arquivado permanece intacto. Não limpa texto gravado nos pixels — alguém ainda precisa olhar as imagens.',
        'C-FIND, C-MOVE and C-GET over an indexed view of what is actually on disk, so a twelve-year-old ultrasound or CR reader can ask what you hold and pull it back.': 'C-FIND, C-MOVE e C-GET sobre um índice do que está realmente em disco, para que um ultrassom ou um leitor de CR de doze anos atrás consiga perguntar o que você tem e puxar de volta.',
        'QIDO-RS, WADO-RS and STOW-RS, so OHIF, Weasis and other modern viewers can read the archive over HTTP without negotiating a DICOM association.': 'QIDO-RS, WADO-RS e STOW-RS, para que OHIF, Weasis e outros visualizadores modernos leiam o arquivo por HTTP sem negociar uma associação DICOM.',
        '📋 Worklist and emergency RIS': '📋 Worklist e RIS de emergência',
        'Takes HL7 orders over MLLP or hand-keyed ones, and serves them to modalities as a Modality Worklist. If your primary PACS stops answering, it can take over, hold what arrives, and forward it once the primary is back.': 'Recebe pedidos HL7 por MLLP — ou digitados à mão — e os serve às modalidades como Modality Worklist. Se o seu PACS principal parar de responder, ele assume, segura o que chega e encaminha quando o principal volta.',
        '🖨️ Virtual print': '🖨️ Impressão virtual',
        'Captures print-only modalities as PDF, so a machine whose only output is film still produces something you can file.': 'Captura em PDF as modalidades que só sabem imprimir, para que um equipamento cuja única saída é o filme continue produzindo algo arquivável.',
        '🔑 Token authentication': '🔑 Autenticação por token',
        'The dashboard and the DICOMweb API take a single shared token. Bind them to anything other than localhost without one and the server refuses to start — the refusal is the feature.': 'O painel e a API DICOMweb usam um único token compartilhado. Exponha-os fora do localhost sem token e o servidor se recusa a iniciar — a recusa é o recurso.',
        'What it is not': 'O que ele não é',
        'Not a medical device.': 'Não é um dispositivo médico.',
        'It is not certified, cleared or registered anywhere, and nothing in it has been validated for clinical use by anyone. Whoever deploys it owns that validation.': 'Não tem certificação, registro na ANVISA nem autorização em lugar nenhum, e nada nele foi validado para uso clínico por ninguém. Quem implanta assume essa validação.',
        'Not for primary diagnosis.': 'Não serve para diagnóstico primário.',
        'There is no diagnostic viewer here: no windowing, no measurements, no rendering pipeline. Read studies on the validated workstation you already have.': 'Aqui não há visualizador diagnóstico: sem janelamento, sem medições, sem pipeline de renderização. Faça o laudo na estação de trabalho validada que você já tem.',
        'Not an enterprise archive.': 'Não é um arquivo corporativo.',
        'No high availability, no clustering, no retention policies, and no encryption at rest — put it on an encrypted disk. It has its own profiles and audit trail, but no LDAP, no Active Directory and no single sign-on, so accounts live on the appliance rather than with your identity provider.': 'Sem alta disponibilidade, sem clustering, sem políticas de retenção e sem criptografia em repouso — coloque-o sobre um disco criptografado. Ele tem os próprios perfis e a própria trilha de auditoria, mas não fala LDAP, nem Active Directory, nem logon único, então as contas ficam no equipamento e não no seu provedor de identidade.',
        'Not a replacement for your PACS or your RIS.': 'Não substitui seu PACS nem seu RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Ele é o gateway entre os dois, e o que mantém o setor funcionando durante uma queda até que voltem.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Se o cuidado de um paciente depender disso, a responsabilidade é sua, não do software.',
        'For technical users': 'Para usuários técnicos',
        '— DICOM details, CLI & source': '— detalhes DICOM, CLI e código-fonte',
        'Security policy': 'Política de segurança',
        'Build & release': 'Build e release',
        'Version': 'Versão',
        'All versions and changelogs →': 'Todas as versões e changelogs →',
        '📖 Read the manual': '📖 Ler o manual',
        'First launch': 'Primeira execução',
        'What it is (and is not)': 'O que é (e o que não é)',
        'Features': 'Funcionalidades',
        '🖥 Server': '🖥 Servidor',
        'Run it on a server': 'Rodar em um servidor',
        'No installer for these — all three run the same application. Pick the one your machine already speaks.': 'Para estes não há instalador: os três rodam a mesma aplicação. Escolha o que a sua máquina já fala.',
        'Compose file, everything on loopback. The first boot prints an access token — open http://127.0.0.1:8042/ and paste it when the dashboard asks.': 'Arquivo compose, tudo em loopback. A primeira inicialização imprime um token de acesso: abra http://127.0.0.1:8042/ e cole quando o painel pedir.',
        'Rootless, and systemd owns it. Needs no compose provider, and the token prints to the journal on first boot.': 'Sem root, e o systemd cuida dele. Não precisa de provedor de compose, e o token é impresso no journal na primeira inicialização.',
        'From source, as a system service with an account of its own. The installer stops before starting it — opening listeners that accept patient data stays your decision.': 'A partir do código, como serviço do sistema com conta própria. O instalador para antes de iniciá-lo: abrir portas que aceitam dados de pacientes continua sendo sua decisão.',
        'Details →': 'Detalhes ↓',
        'Full deployment guide →': 'Guia completo de implantação →',

        // ── Profiles, audit trail and emergency notification ──
        '👥 People and permissions': '👥 Pessoas e permissões',
        'Optional per-person sign-in with four editable presets. Permissions are checked at every endpoint, not hidden in the browser, and you choose per profile which patient identifiers each person may see — so IT can trace a study by accession number without reading anyone\'s chart.': 'Login por pessoa, opcional, com quatro perfis predefinidos e editáveis. As permissões são verificadas em cada endpoint, não escondidas no navegador, e você escolhe por perfil quais identificadores do paciente cada pessoa vê — assim a TI rastreia um estudo pelo número de acesso sem ler o prontuário de ninguém.',
        '🔒 Audit trail': '🔒 Trilha de auditoria',
        'Append-only, hash-chained records of who did what, to which study, from where, and whether it worked — refusals included. Any edit or deletion inside the file breaks the chain and the dashboard says which record and why.': 'Registros somente-acréscimo, encadeados por hash: quem fez o quê, em qual estudo, de onde e se deu certo — recusas incluídas. Qualquer edição ou exclusão dentro do arquivo quebra a cadeia, e o painel diz em qual registro e por quê.',

        // ── What it is, and which release a capability ships in ──
        'What it is': 'O que é',
        'A gateway between your equipment and your archive.': 'Um gateway entre os seus equipamentos e o seu arquivo.',
        'Studies arrive, get routed by rules you write, and are retried until every destination has taken them.': 'Os estudos chegam, são roteados por regras que você escreve e são repetidos até que todos os destinos os aceitem.',
        'A continuity appliance.': 'Um equipamento de continuidade.',
        'When the primary PACS stops answering, it serves the worklist itself, holds what arrives, and back-fills once the primary returns.': 'Quando o PACS principal para de responder, ele mesmo serve a worklist, retém o que chega e reenvia assim que o principal volta.',
        'A translator for equipment nothing else will talk to.': 'Um tradutor para equipamentos com os quais nada mais quer conversar.',
        'Print-only modalities, consoles with no RIS feed, readers that speak nothing but DIMSE.': 'Equipamentos que só imprimem, consoles sem conexão com o RIS, leitores que não falam nada além de DIMSE.',
        'Yours, on your hardware.': 'Seu, no seu próprio hardware.',
        'One config file, one process, no cloud, no telemetry, no licence server. AGPL-3.0.': 'Um arquivo de configuração, um processo, sem nuvem, sem telemetria, sem servidor de licenças. AGPL-3.0.',
        'Every service is off until you turn it on. The tag on each card is the release it ships in.': 'Cada serviço fica desligado até você ligá-lo. A etiqueta de cada cartão é a versão em que ele sai.',
    },
    ja: {
        'Late shift.': '夜勤お疲れさま。',
        'Good morning.': 'おはようございます。',
        'Good afternoon.': 'こんにちは。',
        'Good evening.': 'こんばんは。',
        'Your PACS systems are down?': 'PACSがダウン？',
        'Urgent patients cannot wait.': '急患は待ってくれません。',
        'recommended': '推奨',
        'Checking for the latest version…': '最新バージョンを確認中…',
        "First launch shows a security warning? Here's how to open it": '初回起動でセキュリティ警告が出る？開き方はこちら',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'この警告はアプリがまだコード署名されていないためです。安全です。',
        '📥 Receive and file': '📥 受信して保存',
        'A Storage SCP that accepts C-STORE and C-ECHO and files each study to disk by patient, study and series. Compressed objects are stored exactly as they arrived — never transcoded.': 'C-STOREとC-ECHOを受け付けるStorage SCP。患者・検査・シリーズ別にディスクへ保存します。圧縮オブジェクトは届いたまま保存し、トランスコードは一切行いません。',
        '📤 Route and forward': '📤 振り分けて転送',
        'Forwards to as many nodes as you like, with rules: CT from the ER to the archive, ultrasound to the reading room. Each destination is retried until it accepts. A file that matches no rule goes everywhere rather than nowhere.': '任意の数のノードへ転送でき、ルールも書けます（救急のCTはアーカイブへ、超音波は読影室へ）。宛先ごとに受理されるまで再試行します。どのルールにも一致しないファイルは、どこにも送られないのではなく全宛先へ送られます。',
        '🕶️ De-identify on the way out': '🕶️ 送信時に匿名化',
        'A rule can de-identify the copy it sends (PS3.15 Basic profile) while the archived original stays untouched. It does not clean burned-in pixel text — a human still has to look at the images.': 'ルールごとに、送り出すコピーだけを匿名化できます（PS3.15の基本プロファイル）。保存済みの原本は書き換えません。ピクセルに焼き込まれた文字は消えないため、画像は人が確認する必要があります。',
        'C-FIND, C-MOVE and C-GET over an indexed view of what is actually on disk, so a twelve-year-old ultrasound or CR reader can ask what you hold and pull it back.': 'ディスク上の実体をインデックス化したうえでC-FIND / C-MOVE / C-GETに応答します。12年前の超音波装置やCRリーダーでも、保有する検査を問い合わせて取り出せます。',
        'QIDO-RS, WADO-RS and STOW-RS, so OHIF, Weasis and other modern viewers can read the archive over HTTP without negotiating a DICOM association.': 'QIDO-RS・WADO-RS・STOW-RSに対応。OHIFやWeasisなどの最新ビューアが、DICOMアソシエーションを結ばずHTTPでアーカイブを読めます。',
        '📋 Worklist and emergency RIS': '📋 ワークリストと緊急RIS',
        'Takes HL7 orders over MLLP or hand-keyed ones, and serves them to modalities as a Modality Worklist. If your primary PACS stops answering, it can take over, hold what arrives, and forward it once the primary is back.': 'MLLP経由のHL7オーダー（手入力も可）を受け取り、Modality Worklistとしてモダリティへ配信します。主PACSが応答しなくなったら代役を務め、届いた検査を保留し、復旧後に転送します。',
        '🖨️ Virtual print': '🖨️ 仮想プリント',
        'Captures print-only modalities as PDF, so a machine whose only output is film still produces something you can file.': '印刷しか出力手段のないモダリティをPDFとして取り込みます。フィルム出力しかできない装置でも、保存できる形が残ります。',
        '🔑 Token authentication': '🔑 トークン認証',
        'The dashboard and the DICOMweb API take a single shared token. Bind them to anything other than localhost without one and the server refuses to start — the refusal is the feature.': 'ダッシュボードとDICOMweb APIは単一の共有トークンを使います。トークンなしでlocalhost以外に公開しようとすると、サーバーは起動を拒否します。この拒否こそが機能です。',
        'What it is not': 'これは何ではないか',
        'Not a medical device.': '医療機器ではありません。',
        'It is not certified, cleared or registered anywhere, and nothing in it has been validated for clinical use by anyone. Whoever deploys it owns that validation.': 'どの国でも認証・承認・登録を受けておらず、臨床使用のための妥当性確認も誰も行っていません。導入する側がその責任を負います。',
        'Not for primary diagnosis.': '一次読影には使えません。',
        'There is no diagnostic viewer here: no windowing, no measurements, no rendering pipeline. Read studies on the validated workstation you already have.': '診断用ビューアはありません。ウィンドウ調整も計測もレンダリングもありません。読影は既存の検証済みワークステーションで行ってください。',
        'Not an enterprise archive.': 'エンタープライズアーカイブではありません。',
        'No high availability, no clustering, no retention policies, and no encryption at rest — put it on an encrypted disk. It has its own profiles and audit trail, but no LDAP, no Active Directory and no single sign-on, so accounts live on the appliance rather than with your identity provider.': '冗長構成なし、クラスタリングなし、保存期間ポリシーなし、保存時暗号化なし — 暗号化したディスク上で運用してください。独自のプロファイルと監査証跡は備えていますが、LDAP・Active Directory・シングルサインオンには対応していないため、アカウントはID基盤側ではなくこの装置側で管理します。',
        'Not a replacement for your PACS or your RIS.': 'PACSやRISの置き換えではありません。',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'それらをつなぐゲートウェイであり、障害中も部門を動かし続け、復旧を待つための仕組みです。',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": '患者の診療がこれに依存するなら、その責任はソフトウェアではなく導入した側にあります。',
        'For technical users': '技術者向け',
        '— DICOM details, CLI & source': '— DICOMの詳細・CLI・ソース',
        'Security policy': 'セキュリティポリシー',
        'Build & release': 'ビルドとリリース',
        'Version': 'バージョン',
        'All versions and changelogs →': '全バージョンと変更履歴 →',
        '📖 Read the manual': '📖 マニュアルを読む',
        'First launch': '初回起動',
        'What it is (and is not)': 'これは何か（そして何ではないか）',
        'Features': '機能',
        '🖥 Server': '🖥 サーバー',
        'Run it on a server': 'サーバーで動かす',
        'No installer for these — all three run the same application. Pick the one your machine already speaks.': 'これらにインストーラーはありません。3つとも同じアプリケーションが動きます。お使いのマシンが既に扱えるものを選んでください。',
        'Compose file, everything on loopback. The first boot prints an access token — open http://127.0.0.1:8042/ and paste it when the dashboard asks.': 'compose ファイル、すべてループバックのみ。初回起動時にアクセストークンが表示されます。http://127.0.0.1:8042/ を開き、ダッシュボードに求められたら貼り付けてください。',
        'Rootless, and systemd owns it. Needs no compose provider, and the token prints to the journal on first boot.': 'root 不要で、systemd が管理します。compose プロバイダーは不要で、トークンは初回起動時に journal に出力されます。',
        'From source, as a system service with an account of its own. The installer stops before starting it — opening listeners that accept patient data stays your decision.': 'ソースから、専用アカウントを持つシステムサービスとして。インストーラーは起動する手前で止まります。患者データを受け付けるポートを開くかどうかは利用者の判断です。',
        'Details →': '詳細 ↓',
        'Full deployment guide →': '導入ガイド全文 →',

        // ── Profiles, audit trail and emergency notification ──
        '👥 People and permissions': '👥 スタッフと権限',
        'Optional per-person sign-in with four editable presets. Permissions are checked at every endpoint, not hidden in the browser, and you choose per profile which patient identifiers each person may see — so IT can trace a study by accession number without reading anyone\'s chart.': '任意で有効にできる個人単位のサインイン。編集可能な 4 つの初期プロファイルが付属します。権限はブラウザ側で隠すのではなく各エンドポイントで検証され、患者識別情報のどれを見せるかはプロファイルごとに選べます。IT 担当者はアクセッション番号で検査を追跡でき、誰のカルテを読む必要もありません。',
        '🔒 Audit trail': '🔒 監査証跡',
        'Append-only, hash-chained records of who did what, to which study, from where, and whether it worked — refusals included. Any edit or deletion inside the file breaks the chain and the dashboard says which record and why.': '追記のみ・ハッシュ連鎖の記録です。誰が・何を・どの検査に対して・どこから行い、成功したかどうかを、拒否された操作も含めて残します。ファイル内で編集や削除を行うと連鎖が壊れ、ダッシュボードがどの記録でなぜ壊れたかを示します。',

        // ── What it is, and which release a capability ships in ──
        'What it is': 'これは何か',
        'A gateway between your equipment and your archive.': '検査機器とアーカイブをつなぐゲートウェイ。',
        'Studies arrive, get routed by rules you write, and are retried until every destination has taken them.': '検査が届き、運用者が書いたルールで振り分けられ、すべての送信先が受け取るまで再試行されます。',
        'A continuity appliance.': '業務を止めないための装置。',
        'When the primary PACS stops answering, it serves the worklist itself, holds what arrives, and back-fills once the primary returns.': '主 PACS が応答しなくなると、自らワークリストを配信し、届いた検査を保持して、主 PACS の復旧後にまとめて送り直します。',
        'A translator for equipment nothing else will talk to.': 'ほかのどの製品も相手にしない機器のための通訳。',
        'Print-only modalities, consoles with no RIS feed, readers that speak nothing but DIMSE.': '印刷しかできないモダリティ、RIS 連携のないコンソール、DIMSE しか話さない読み取り装置。',
        'Yours, on your hardware.': '自分のハードウェア上で、自分のものとして。',
        'One config file, one process, no cloud, no telemetry, no licence server. AGPL-3.0.': '設定ファイル 1 つ、プロセス 1 つ。クラウドなし、テレメトリなし、ライセンスサーバーなし。AGPL-3.0。',
        'Every service is off until you turn it on. The tag on each card is the release it ships in.': '各サービスは有効にするまで停止しています。カードのタグは、その機能が入るリリースを示します。',
    },
    ru: {
        'Late shift.': 'Ночная смена.',
        'Good morning.': 'Доброе утро.',
        'Good afternoon.': 'Добрый день.',
        'Good evening.': 'Добрый вечер.',
        'Your PACS systems are down?': 'PACS не работает?',
        'Urgent patients cannot wait.': 'Экстренные пациенты не могут ждать.',
        'recommended': 'рекомендуется',
        'Checking for the latest version…': 'Проверяем последнюю версию…',
        "First launch shows a security warning? Here's how to open it": 'При первом запуске появляется предупреждение безопасности? Вот как открыть',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'Предупреждение появляется потому, что приложение ещё не имеет цифровой подписи — оно безопасно.',
        '📥 Receive and file': '📥 Приём и раскладка',
        'A Storage SCP that accepts C-STORE and C-ECHO and files each study to disk by patient, study and series. Compressed objects are stored exactly as they arrived — never transcoded.': 'Storage SCP принимает C-STORE и C-ECHO и раскладывает каждое исследование на диск по пациенту, исследованию и серии. Сжатые объекты сохраняются ровно такими, какими пришли, — без перекодирования.',
        '📤 Route and forward': '📤 Маршрутизация и пересылка',
        'Forwards to as many nodes as you like, with rules: CT from the ER to the archive, ultrasound to the reading room. Each destination is retried until it accepts. A file that matches no rule goes everywhere rather than nowhere.': 'Пересылает на любое число узлов, с правилами: КТ из приёмного — в архив, УЗИ — на рабочее место врача. Каждый адресат повторяется, пока не подтвердит приём. Файл, не подошедший ни под одно правило, уходит на все адреса, а не в никуда.',
        '🕶️ De-identify on the way out': '🕶️ Обезличивание на выходе',
        'A rule can de-identify the copy it sends (PS3.15 Basic profile) while the archived original stays untouched. It does not clean burned-in pixel text — a human still has to look at the images.': 'Правило может обезличить отправляемую копию (базовый профиль PS3.15), а сохранённый оригинал остаётся нетронутым. Текст, впечатанный в пиксели, не удаляется — снимки всё равно должен просмотреть человек.',
        'C-FIND, C-MOVE and C-GET over an indexed view of what is actually on disk, so a twelve-year-old ultrasound or CR reader can ask what you hold and pull it back.': 'C-FIND, C-MOVE и C-GET поверх индекса того, что действительно лежит на диске, чтобы двенадцатилетний УЗИ-аппарат или CR-дигитайзер мог спросить, что у вас есть, и забрать это.',
        'QIDO-RS, WADO-RS and STOW-RS, so OHIF, Weasis and other modern viewers can read the archive over HTTP without negotiating a DICOM association.': 'QIDO-RS, WADO-RS и STOW-RS — OHIF, Weasis и другие современные просмотрщики читают архив по HTTP, не устанавливая DICOM-ассоциацию.',
        '📋 Worklist and emergency RIS': '📋 Рабочий список и аварийная RIS',
        'Takes HL7 orders over MLLP or hand-keyed ones, and serves them to modalities as a Modality Worklist. If your primary PACS stops answering, it can take over, hold what arrives, and forward it once the primary is back.': 'Принимает HL7-заказы по MLLP или введённые вручную и отдаёт их модальностям как Modality Worklist. Если основной PACS перестал отвечать, берёт работу на себя, придерживает поступающее и пересылает, когда основной вернётся.',
        '🖨️ Virtual print': '🖨️ Виртуальная печать',
        'Captures print-only modalities as PDF, so a machine whose only output is film still produces something you can file.': 'Принимает как PDF те модальности, которые умеют только печатать: аппарат с единственным выходом на плёнку всё равно даёт что-то, что можно сохранить.',
        '🔑 Token authentication': '🔑 Аутентификация по токену',
        'The dashboard and the DICOMweb API take a single shared token. Bind them to anything other than localhost without one and the server refuses to start — the refusal is the feature.': 'Панель и DICOMweb API используют один общий токен. Откройте их за пределы localhost без токена — и сервер откажется стартовать. Этот отказ и есть функция.',
        'What it is not': 'Чем он не является',
        'Not a medical device.': 'Это не медицинское изделие.',
        'It is not certified, cleared or registered anywhere, and nothing in it has been validated for clinical use by anyone. Whoever deploys it owns that validation.': 'Оно нигде не сертифицировано, не зарегистрировано и не разрешено к применению, и никто не проводил его валидацию для клинического использования. Ответственность за валидацию несёт тот, кто его разворачивает.',
        'Not for primary diagnosis.': 'Не для первичной диагностики.',
        'There is no diagnostic viewer here: no windowing, no measurements, no rendering pipeline. Read studies on the validated workstation you already have.': 'Здесь нет диагностического просмотрщика: ни оконного преобразования, ни измерений, ни конвейера отрисовки. Описывайте исследования на уже имеющейся валидированной рабочей станции.',
        'Not an enterprise archive.': 'Это не корпоративный архив.',
        'No high availability, no clustering, no retention policies, and no encryption at rest — put it on an encrypted disk. It has its own profiles and audit trail, but no LDAP, no Active Directory and no single sign-on, so accounts live on the appliance rather than with your identity provider.': 'Нет отказоустойчивости, кластеризации, политик хранения и шифрования на диске — разместите его на зашифрованном диске. У него есть собственные профили и собственный журнал аудита, но нет ни LDAP, ни Active Directory, ни единого входа, поэтому учётные записи живут на самом устройстве, а не у вашего поставщика удостоверений.',
        'Not a replacement for your PACS or your RIS.': 'Он не заменяет ни PACS, ни RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Это шлюз между ними и то, что позволяет отделению работать во время аварии, пока они не вернутся.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Если от этого зависит помощь пациенту, ответственность за это на вас, а не на программе.',
        'For technical users': 'Для технических специалистов',
        '— DICOM details, CLI & source': '— детали DICOM, CLI и исходный код',
        'Security policy': 'Политика безопасности',
        'Build & release': 'Сборка и релиз',
        'Version': 'Версия',
        'All versions and changelogs →': 'Все версии и списки изменений →',
        '📖 Read the manual': '📖 Читать руководство',
        'First launch': 'Первый запуск',
        'What it is (and is not)': 'Что это (и чем не является)',
        'Features': 'Возможности',
        '🖥 Server': '🖥 Сервер',
        'Run it on a server': 'Запуск на сервере',
        'No installer for these — all three run the same application. Pick the one your machine already speaks.': 'Для них нет установщика — все три запускают одно и то же приложение. Выберите то, что ваша машина уже понимает.',
        'Compose file, everything on loopback. The first boot prints an access token — open http://127.0.0.1:8042/ and paste it when the dashboard asks.': 'Файл compose, всё только на loopback. При первом запуске печатается токен доступа: откройте http://127.0.0.1:8042/ и вставьте его, когда панель попросит.',
        'Rootless, and systemd owns it. Needs no compose provider, and the token prints to the journal on first boot.': 'Без root, и systemd им управляет. Провайдер compose не нужен, а токен печатается в journal при первом запуске.',
        'From source, as a system service with an account of its own. The installer stops before starting it — opening listeners that accept patient data stays your decision.': 'Из исходников, как системная служба с собственной учётной записью. Установщик останавливается перед запуском: открывать порты, принимающие данные пациентов, — ваше решение.',
        'Details →': 'Подробнее ↓',
        'Full deployment guide →': 'Полное руководство по развёртыванию →',

        // ── Profiles, audit trail and emergency notification ──
        '👥 People and permissions': '👥 Люди и права',
        'Optional per-person sign-in with four editable presets. Permissions are checked at every endpoint, not hidden in the browser, and you choose per profile which patient identifiers each person may see — so IT can trace a study by accession number without reading anyone\'s chart.': 'Необязательный вход для каждого человека с четырьмя редактируемыми заготовками. Права проверяются на каждом эндпоинте, а не прячутся в браузере, и вы для каждого профиля выбираете, какие идентификаторы пациента ему показывать, — так ИТ отследит исследование по номеру регистрации, не читая ничью карту.',
        '🔒 Audit trail': '🔒 Журнал аудита',
        'Append-only, hash-chained records of who did what, to which study, from where, and whether it worked — refusals included. Any edit or deletion inside the file breaks the chain and the dashboard says which record and why.': 'Записи только на дополнение, связанные хешами: кто, что, с каким исследованием, откуда и получилось ли, включая отказы. Любая правка или удаление внутри файла рвёт цепочку, а панель говорит, на какой записи и почему.',

        // ── What it is, and which release a capability ships in ──
        'What it is': 'Что это',
        'A gateway between your equipment and your archive.': 'Шлюз между вашим оборудованием и вашим архивом.',
        'Studies arrive, get routed by rules you write, and are retried until every destination has taken them.': 'Исследования поступают, маршрутизируются по вашим правилам и повторяются, пока их не примет каждый получатель.',
        'A continuity appliance.': 'Устройство непрерывности работы.',
        'When the primary PACS stops answering, it serves the worklist itself, holds what arrives, and back-fills once the primary returns.': 'Когда основной PACS перестаёт отвечать, он сам раздаёт рабочий список, удерживает поступающее и досылает всё, как только основной вернётся.',
        'A translator for equipment nothing else will talk to.': 'Переводчик для оборудования, с которым больше ничто не разговаривает.',
        'Print-only modalities, consoles with no RIS feed, readers that speak nothing but DIMSE.': 'Аппараты, умеющие только печатать, консоли без канала от RIS, считыватели, знающие лишь DIMSE.',
        'Yours, on your hardware.': 'Ваш, на вашем железе.',
        'One config file, one process, no cloud, no telemetry, no licence server. AGPL-3.0.': 'Один файл конфигурации, один процесс, без облака, без телеметрии, без сервера лицензий. AGPL-3.0.',
        'Every service is off until you turn it on. The tag on each card is the release it ships in.': 'Каждая служба выключена, пока вы её не включите. Метка на карточке — это выпуск, в котором она появляется.',
    },
};

// Rich blocks: paragraphs/list items mixing text with inline children.
// Keyed by CSS selector; values are full innerHTML per locale (en = original
// markup, restored from a snapshot captured on first pass). Inline tags and
// links mirror the English markup exactly.
const RICH = {
    // RICH is innerHTML and nothing checks inside it, so these four have to be
    // moved by hand whenever the English lede moves. They were last widened when
    // the lede gained the hold-and-back-fill sentence and the de-identification
    // and audit-trail clause.
    '.lede': {
        es: '<strong>Carino PACS</strong> es una pasarela <abbr title="el formato y el protocolo estándar de las imágenes médicas de los equipos: rayos X, TC, RM, ecografía…">DICOM</abbr> autoalojada y un equipo de continuidad. Recibe estudios, los enruta y los reenvía según las reglas que tú escribes, responde a <em>Query/Retrieve</em> y <em>DICOMweb</em>, y sirve él mismo la worklist mientras tu PACS está inaccesible: retiene todo lo que llega y lo reenvía en cuanto el principal vuelve a responder. Puede anonimizar la copia que sale y guarda una auditoría de quién hizo qué. Un archivo de configuración, un proceso, sin nube.',
        'pt-BR': '<strong>Carino PACS</strong> é um gateway <abbr title="o formato e o protocolo padrão das imagens médicas dos equipamentos: raio-X, TC, RM, ultrassom…">DICOM</abbr> auto-hospedado e um equipamento de continuidade. Recebe estudos, roteia e encaminha conforme as regras que você escreve, responde a <em>Query/Retrieve</em> e <em>DICOMweb</em>, e serve a própria worklist enquanto o seu PACS está inacessível: segura tudo o que chega e reenvia assim que o principal volta a responder. Pode anonimizar a cópia que sai e mantém uma trilha de auditoria de quem fez o quê. Um arquivo de configuração, um processo, sem nuvem.',
        ja: '<strong>Carino PACS</strong> は自前で運用する<abbr title="X線・CT・MRI・超音波など医用画像の標準フォーマットおよび通信規格">DICOM</abbr>ゲートウェイであり、業務を止めないための装置です。検査を受信し、自分で書いたルールで振り分けて転送し、<em>Query/Retrieve</em>と<em>DICOMweb</em>に応答し、PACSに届かない間はワークリストを自ら配信します。届いた検査はすべて保持し、本番のPACSが応答した時点でまとめて送り直します。送信するコピーの匿名化もでき、誰が何をしたかの監査証跡も残ります。設定ファイル1つ、プロセス1つ、クラウド不要。',
        ru: '<strong>Carino PACS</strong> — разворачиваемый у себя <abbr title="стандартный формат и сетевой протокол медицинских изображений: рентген, КТ, МРТ, УЗИ…">DICOM</abbr>-шлюз и устройство непрерывности работы. Он принимает исследования, маршрутизирует и пересылает их по вашим правилам, отвечает на <em>Query/Retrieve</em> и <em>DICOMweb</em> и сам раздаёт рабочий список, пока ваш PACS недоступен: удерживает всё поступившее и досылает, как только основной снова отвечает. Может обезличить отправляемую копию и ведёт журнал того, кто что сделал. Один файл конфигурации, один процесс, без облака.',
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
        es: 'Construido sobre <code>pynetdicom</code>/<code>pydicom</code> con un panel en Flask; la app de escritorio es un shell de bandeja en Electron sobre el mismo motor.',
        'pt-BR': 'Construído sobre <code>pynetdicom</code>/<code>pydicom</code> com um painel em Flask; o app de desktop é um shell de bandeja em Electron sobre o mesmo motor.',
        ja: '<code>pynetdicom</code>/<code>pydicom</code>とFlaskダッシュボードで構成。デスクトップアプリは同じエンジンをElectronのトレイシェルで包んだものです。',
        ru: 'Построен на <code>pynetdicom</code>/<code>pydicom</code> с панелью на Flask; настольное приложение — Electron-оболочка в трее вокруг того же движка.',
    },
    '#tl-scp': {
        es: '<b>Storage SCP</b> — C-STORE + C-ECHO, archiva por Paciente/Estudio/Serie, todas las sintaxis de transferencia (lo comprimido se guarda tal cual), filtrado por <code>allowed_aets</code>.',
        'pt-BR': '<b>Storage SCP</b> — C-STORE + C-ECHO, arquiva por Paciente/Estudo/Série, todas as sintaxes de transferência (comprimidos guardados como estão), filtro por <code>allowed_aets</code>.',
        ja: '<b>Storage SCP</b> — C-STORE + C-ECHO。患者/検査/シリーズ別に保存、全転送構文に対応（圧縮データはそのまま保存）、<code>allowed_aets</code>によるフィルタ。',
        ru: '<b>Storage SCP</b> — C-STORE + C-ECHO, раскладка Пациент/Исследование/Серия, все синтаксисы передачи (сжатые хранятся как есть), фильтр <code>allowed_aets</code>.',
    },
    '#tl-scu': {
        es: '<b>Storage SCU</b> — reenvío automático por vigilancia de carpeta a N nodos, reglas de enrutamiento condicional, reintentos por destino, conservar/mover/borrar al completar.',
        'pt-BR': '<b>Storage SCU</b> — encaminhamento automático por monitoramento de pasta para N nós, regras de roteamento condicional, novas tentativas por destino, manter/mover/excluir ao concluir.',
        ja: '<b>Storage SCU</b> — フォルダ監視でN個のノードへ自動転送。条件付きルーティング、宛先ごとの再試行、成功時に保持/移動/削除。',
        ru: '<b>Storage SCU</b> — автопересылка из отслеживаемой папки на N узлов, условные правила маршрутизации, повторы по каждому адресату, сохранить/переместить/удалить после успеха.',
    },
    '#tl-qr': {
        es: '<b>Query/Retrieve SCP</b> — C-FIND / C-MOVE / C-GET, Patient y Study Root, resueltos desde un índice sqlite de lo que hay en disco; las sub-operaciones fallidas se nombran, nunca se descartan.',
        'pt-BR': '<b>Query/Retrieve SCP</b> — C-FIND / C-MOVE / C-GET, Patient e Study Root, respondidos a partir de um índice sqlite do que está em disco; sub-operações que falham são nomeadas, nunca descartadas.',
        ja: '<b>Query/Retrieve SCP</b> — C-FIND / C-MOVE / C-GET、Patient RootとStudy Rootに対応。ディスク上の内容を持つsqliteインデックスから応答し、失敗したサブオペレーションは必ず列挙され、握りつぶされません。',
        ru: '<b>Query/Retrieve SCP</b> — C-FIND / C-MOVE / C-GET, Patient и Study Root, ответы из sqlite-индекса того, что лежит на диске; неудавшиеся суб-операции перечисляются поимённо и никогда не теряются.',
    },
    '#tl-web': {
        es: '<b>DICOMweb</b> — QIDO-RS, WADO-RS, STOW-RS bajo <code>/dicom-web</code>, lista CORS de coincidencia exacta, sin comodines. Rendered/thumbnail/transcodificación responden 406 en vez de fingirlo.',
        'pt-BR': '<b>DICOMweb</b> — QIDO-RS, WADO-RS, STOW-RS em <code>/dicom-web</code>, lista CORS de correspondência exata, sem curinga. Rendered/thumbnail/transcodificação respondem 406 em vez de fingir.',
        ja: '<b>DICOMweb</b> — <code>/dicom-web</code>配下でQIDO-RS・WADO-RS・STOW-RS。CORSは完全一致の許可リストのみでワイルドカードなし。rendered/thumbnail/トランスコードは偽らず406を返します。',
        ru: '<b>DICOMweb</b> — QIDO-RS, WADO-RS, STOW-RS по пути <code>/dicom-web</code>, точный список разрешённых CORS-источников, без подстановочных знаков. Rendered/thumbnail/перекодирование отвечают 406, а не подделывают результат.',
    },
    '#tl-mwl': {
        es: '<b>MWL + HL7</b> — SCP C-FIND de Modality Worklist, HL7 <code>ORM^O01</code> sobre MLLP, conciliación por número de accession. La entrega de imágenes nunca depende de que exista una orden.',
        'pt-BR': '<b>MWL + HL7</b> — SCP C-FIND de Modality Worklist, HL7 <code>ORM^O01</code> sobre MLLP, conciliação por accession number. A entrega das imagens nunca depende de haver pedido correspondente.',
        ja: '<b>MWL + HL7</b> — Modality WorklistのC-FIND SCP、MLLP上のHL7 <code>ORM^O01</code>、Accession Numberによる突合。画像の配信がオーダー突合の成否に左右されることはありません。',
        ru: '<b>MWL + HL7</b> — C-FIND SCP рабочего списка, HL7 <code>ORM^O01</code> поверх MLLP, сверка по accession number. Доставка изображений никогда не зависит от совпадения с заказом.',
    },
    '#tl-deid': {
        es: '<b>Anonimización</b> — perfil básico de PS3.15 Anexo E al reenviar, con las opciones de retención declaradas en (0012,0064). No toca los píxeles.',
        'pt-BR': '<b>Anonimização</b> — perfil básico da PS3.15 Anexo E no encaminhamento, com as opções de retenção declaradas em (0012,0064). Não toca nos pixels.',
        ja: '<b>匿名化</b> — 転送時にPS3.15 Annex Eの基本プロファイルを適用し、保持オプションを(0012,0064)に明示。ピクセルには手を触れません。',
        ru: '<b>Обезличивание</b> — базовый профиль PS3.15 Annex E при пересылке, применённые опции сохранения объявляются в (0012,0064). Пиксели не изменяются.',
    },
    '#tl-tls': {
        es: '<b>DICOM-TLS</b> en ambos lados (opcional), incl. TLS mutuo. Autenticación por token en la API HTTP; un <code>web.host</code> fuera de loopback con el token vacío es un error de arranque.',
        'pt-BR': '<b>DICOM-TLS</b> dos dois lados (opcional), incl. TLS mútuo. Autenticação por token na API HTTP; um <code>web.host</code> fora de loopback com token vazio é erro de inicialização.',
        ja: '<b>DICOM-TLS</b> 送受信の両側で対応（オプション）。相互TLSも可。HTTP APIはBearerトークン認証で、ループバック以外の<code>web.host</code>にトークン未設定なら起動時エラーになります。',
        ru: '<b>DICOM-TLS</b> с обеих сторон (опционально), включая взаимный TLS. Bearer-токен для HTTP API; не-loopback <code>web.host</code> с пустым токеном — ошибка запуска.',
    },
    '#tl-ui': {
        es: 'Panel web, CLI sin interfaz (<code>pacs serve|receive|send|echo|ris|mwl|qr</code>), app de bandeja, imagen Docker o unidad systemd. Puerto DICOM <code>11112</code>; panel en <code>127.0.0.1:8042</code>.',
        'pt-BR': 'Painel web, CLI headless (<code>pacs serve|receive|send|echo|ris|mwl|qr</code>), app de bandeja, imagem Docker ou unidade systemd. Porta DICOM <code>11112</code>; painel em <code>127.0.0.1:8042</code>.',
        ja: 'Webダッシュボード、ヘッドレスCLI（<code>pacs serve|receive|send|echo|ris|mwl|qr</code>）、トレイアプリ、Dockerイメージ、systemdユニット。DICOMポートは<code>11112</code>、ダッシュボードは<code>127.0.0.1:8042</code>。',
        ru: 'Веб-панель, headless CLI (<code>pacs serve|receive|send|echo|ris|mwl|qr</code>), приложение в трее, образ Docker или systemd-юнит. DICOM-порт <code>11112</code>; панель — <code>127.0.0.1:8042</code>.',
    },
    // Kept in step with the English markup by hand, because RICH is innerHTML and
    // nothing checks inside it: when the trailing link was dropped from the note
    // and Podman added, these four still carried the old sentence AND an anchor
    // to a section that no longer exists — visible only to a reader in one of
    // these languages.
    '#dl-release': {
        es: 'Estos instaladores son <b>v1.0.0</b>: solo reciben y reenvían. Todo lo demás de esta página es <b>v1.1.0</b>, que ya funciona hoy con Docker, Podman, systemd o desde el código. Estos botones solo entregan versiones estables; los instaladores preliminares están en <i>Todas las versiones</i>, arriba.',
        'pt-BR': 'Estes instaladores são <b>v1.0.0</b>: apenas recebem e encaminham. Todo o resto desta página é <b>v1.1.0</b>, que já funciona hoje com Docker, Podman, systemd ou a partir do código. Estes botões só entregam versões estáveis; os instaladores de pré-lançamento ficam em <i>Todas as versões</i>, acima.',
        ja: 'ここにあるインストーラーは <b>v1.0.0</b> で、受信と転送だけを行います。このページの他の機能は <b>v1.1.0</b> で、Docker・Podman・systemd またはソースからなら今日すでに動きます。このボタンから配布されるのは安定版だけです。プレリリース版のインストーラーは上の<i>全バージョン</i>にあります。',
        ru: 'Эти установщики — <b>v1.0.0</b>: только приём и пересылка. Всё остальное на этой странице — <b>v1.1.0</b>, которая уже работает сегодня через Docker, Podman, systemd или из исходников. Эти кнопки выдают только стабильные сборки; предварительные установщики — в разделе <i>Все версии</i> выше.',
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
