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
        'Your PACS systems are down? Urgent patients cannot wait.': '¿Tu PACS está caído? Los pacientes urgentes no pueden esperar.',
        'Keep the images moving,': 'Que las imágenes sigan llegando,',
        'even when a system is down.': 'aunque un sistema se caiga.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Buscando la última versión…',
        'The desktop app is one way in, not the only one — on a server, run it in Docker or as a systemd service.': 'La app de escritorio es una vía de entrada, no la única: en un servidor, ejecútalo en Docker o como servicio systemd.',
        // First-run help
        "First launch shows a security warning? Here's how to open it": '¿La primera vez aparece una advertencia de seguridad? Así se abre',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'La advertencia aparece porque la app aún no está firmada digitalmente; es segura.',
        // Server quick start
        'Running it on a server': 'Ejecutarlo en un servidor',
        '🐧 Linux service (systemd)': '🐧 Servicio de Linux (systemd)',
        // What it does
        'What it does': 'Qué hace',
        'Every service is off until you turn it on. Turn on only what the site actually needs.': 'Cada servicio está apagado hasta que tú lo enciendas. Activa solo lo que el servicio realmente necesita.',
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
        'No high availability, no encryption at rest, no user accounts, no roles, and no per-user audit trail — the log records what happened, never who did it.': 'Sin alta disponibilidad, sin cifrado en reposo, sin cuentas de usuario, sin roles y sin auditoría por usuario: el log registra qué pasó, nunca quién lo hizo.',
        'Not a replacement for your PACS or your RIS.': 'No sustituye a tu PACS ni a tu RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Es la pasarela entre ellos y lo que mantiene funcionando al servicio durante una caída, hasta que vuelvan.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Si la atención de un paciente depende de esto, la responsabilidad es tuya, no del software.',
        // 3 steps
        'Up and running in 3 steps': 'Listo en 3 pasos',
        'Start it — desktop app in the tray, or a container/service on a server.': 'Arráncalo: app de escritorio en la bandeja, o contenedor/servicio en un servidor.',
        'Open the dashboard and pick which services this machine should run.': 'Abre el panel y elige qué servicios debe ejecutar esta máquina.',
        'Add your destinations, point the modalities at it, send a C-ECHO to confirm.': 'Añade tus destinos, apunta las modalidades hacia él y confirma con un C-ECHO.',
        // Documentation
        'Documentation': 'Documentación',
        'Full manuals: getting started, the security model and why the token rule exists, what each service does and when to turn it on.': 'Manuales completos: primeros pasos, el modelo de seguridad y por qué existe la regla del token, y qué hace cada servicio y cuándo conviene activarlo.',
        'Manual (English)': 'Manual (inglés)',
        // Tech box
        'For technical users': 'Para usuarios técnicos',
        '— DICOM details, CLI & source': '— detalles DICOM, CLI y código fuente',
        'Security policy': 'Política de seguridad',
        'Build & release': 'Compilación y release',
        // Footer
        'Not a medical device and not for primary diagnosis. Use TLS, set a token and restrict access before it touches real patient data.': 'No es un producto sanitario ni sirve para diagnóstico primario. Usa TLS, define un token y restringe el acceso antes de que toque datos reales de pacientes.',
        // JS-generated (app.js version line)
        'Latest release:': 'Última versión:',
        'Latest release': 'La última versión',
        'has no installers yet —': 'aún no tiene instaladores;',
        'all versions & notes': 'todas las versiones y notas',
        'see releases': 'ver releases',
        'Version': 'Versión',
        'Coming in v1.1.0': 'Novedades de la v1.1.0',
        'Query/Retrieve SCP — C-FIND, C-MOVE and C-GET, so equipment that only speaks DIMSE can search this archive.': 'Query/Retrieve SCP — C-FIND, C-MOVE y C-GET, para que un equipo que sólo habla DIMSE pueda consultar este archivo.',
        'DICOMweb — QIDO-RS, WADO-RS and STOW-RS, so a browser viewer can read it without ever opening an association.': 'DICOMweb — QIDO-RS, WADO-RS y STOW-RS, para que un visor de navegador lo lea sin abrir nunca una asociación.',
        'Conditional routing — send a study to different destinations by modality, calling AE, station, patient ID or study description.': 'Enrutamiento condicional — envía cada estudio a destinos distintos según modalidad, AE llamante, estación, ID de paciente o descripción del estudio.',
        'De-identification on forward — strip identity as studies leave, while the copy you keep stays untouched.': 'Anonimización al reenviar — quita la identidad cuando el estudio sale, mientras la copia que conservas queda intacta.',
        'Token authentication — and a refusal to start at all if you expose the dashboard without one.': 'Autenticación por token — y una negativa a arrancar si expones el panel sin uno.',
        'Docker image, compose file and a hardened systemd unit, for running it on a server instead of a desktop.': 'Imagen Docker, fichero compose y una unidad systemd endurecida, para ejecutarlo en un servidor y no en un escritorio.',
        'Emergency RIS, Modality Worklist and automatic failover, for the hours your primary PACS is unreachable.': 'RIS de emergencia, Modality Worklist y conmutación automática, para las horas en que tu PACS principal está inaccesible.',
        'Virtual print receiver, for modalities that can only print to film and never learned to C-STORE.': 'Receptor de impresión virtual, para modalidades que sólo saben imprimir a placa y nunca aprendieron a hacer C-STORE.',
    },
    'pt-BR': {
        'Late shift.': 'Turno da noite.',
        'Good morning.': 'Bom dia.',
        'Good afternoon.': 'Boa tarde.',
        'Good evening.': 'Boa noite.',
        'Your PACS systems are down? Urgent patients cannot wait.': 'Seu PACS caiu? Pacientes urgentes não podem esperar.',
        'Keep the images moving,': 'Mantenha as imagens circulando,',
        'even when a system is down.': 'mesmo com um sistema fora do ar.',
        'recommended': 'recomendado',
        'Checking for the latest version…': 'Verificando a versão mais recente…',
        'The desktop app is one way in, not the only one — on a server, run it in Docker or as a systemd service.': 'O app de desktop é uma porta de entrada, não a única: em um servidor, rode em Docker ou como serviço systemd.',
        "First launch shows a security warning? Here's how to open it": 'Apareceu um aviso de segurança na primeira execução? Veja como abrir',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'O aviso aparece porque o app ainda não é assinado digitalmente; ele é seguro.',
        'Running it on a server': 'Rodando em um servidor',
        '🐧 Linux service (systemd)': '🐧 Serviço Linux (systemd)',
        'What it does': 'O que ele faz',
        'Every service is off until you turn it on. Turn on only what the site actually needs.': 'Todo serviço fica desligado até você ligar. Ative apenas o que a unidade realmente precisa.',
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
        'No high availability, no encryption at rest, no user accounts, no roles, and no per-user audit trail — the log records what happened, never who did it.': 'Sem alta disponibilidade, sem criptografia em repouso, sem contas de usuário, sem perfis de acesso e sem trilha de auditoria por usuário — o log registra o que aconteceu, nunca quem fez.',
        'Not a replacement for your PACS or your RIS.': 'Não substitui seu PACS nem seu RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Ele é o gateway entre os dois, e o que mantém o setor funcionando durante uma queda até que voltem.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Se o cuidado de um paciente depender disso, a responsabilidade é sua, não do software.',
        'Up and running in 3 steps': 'Funcionando em 3 passos',
        'Start it — desktop app in the tray, or a container/service on a server.': 'Inicie: app de desktop na bandeja, ou contêiner/serviço em um servidor.',
        'Open the dashboard and pick which services this machine should run.': 'Abra o painel e escolha quais serviços esta máquina deve rodar.',
        'Add your destinations, point the modalities at it, send a C-ECHO to confirm.': 'Adicione seus destinos, aponte as modalidades para ele e confirme com um C-ECHO.',
        'Documentation': 'Documentação',
        'Full manuals: getting started, the security model and why the token rule exists, what each service does and when to turn it on.': 'Manuais completos: primeiros passos, o modelo de segurança e por que a regra do token existe, e o que cada serviço faz e quando ligar.',
        'Manual (English)': 'Manual (inglês)',
        'For technical users': 'Para usuários técnicos',
        '— DICOM details, CLI & source': '— detalhes DICOM, CLI e código-fonte',
        'Security policy': 'Política de segurança',
        'Build & release': 'Build e release',
        'Not a medical device and not for primary diagnosis. Use TLS, set a token and restrict access before it touches real patient data.': 'Não é um dispositivo médico e não serve para diagnóstico primário. Use TLS, defina um token e restrinja o acesso antes de lidar com dados reais de pacientes.',
        'Latest release:': 'Versão mais recente:',
        'Latest release': 'A versão mais recente',
        'has no installers yet —': 'ainda não tem instaladores;',
        'all versions & notes': 'todas as versões e notas',
        'see releases': 'ver releases',
        'Version': 'Versão',
        'Coming in v1.1.0': 'Novidades da v1.1.0',
        'Query/Retrieve SCP — C-FIND, C-MOVE and C-GET, so equipment that only speaks DIMSE can search this archive.': 'Query/Retrieve SCP — C-FIND, C-MOVE e C-GET, para que equipamentos que só falam DIMSE possam consultar este arquivo.',
        'DICOMweb — QIDO-RS, WADO-RS and STOW-RS, so a browser viewer can read it without ever opening an association.': 'DICOMweb — QIDO-RS, WADO-RS e STOW-RS, para que um visualizador de navegador leia sem nunca abrir uma associação.',
        'Conditional routing — send a study to different destinations by modality, calling AE, station, patient ID or study description.': 'Roteamento condicional — envie cada estudo a destinos diferentes por modalidade, AE chamador, estação, ID do paciente ou descrição do estudo.',
        'De-identification on forward — strip identity as studies leave, while the copy you keep stays untouched.': 'Anonimização no encaminhamento — remove a identidade quando o estudo sai, enquanto a cópia que você guarda fica intacta.',
        'Token authentication — and a refusal to start at all if you expose the dashboard without one.': 'Autenticação por token — e a recusa de iniciar caso você exponha o painel sem um.',
        'Docker image, compose file and a hardened systemd unit, for running it on a server instead of a desktop.': 'Imagem Docker, arquivo compose e uma unidade systemd reforçada, para rodar em um servidor em vez de um desktop.',
        'Emergency RIS, Modality Worklist and automatic failover, for the hours your primary PACS is unreachable.': 'RIS de emergência, Modality Worklist e failover automático, para as horas em que o seu PACS principal está inacessível.',
        'Virtual print receiver, for modalities that can only print to film and never learned to C-STORE.': 'Receptor de impressão virtual, para modalidades que só sabem imprimir em filme e nunca aprenderam a fazer C-STORE.',
    },
    ja: {
        'Late shift.': '夜勤お疲れさま。',
        'Good morning.': 'おはようございます。',
        'Good afternoon.': 'こんにちは。',
        'Good evening.': 'こんばんは。',
        'Your PACS systems are down? Urgent patients cannot wait.': 'PACSがダウン？急患は待ってくれません。',
        'Keep the images moving,': '画像を止めない、',
        'even when a system is down.': 'システムが落ちても。',
        'recommended': '推奨',
        'Checking for the latest version…': '最新バージョンを確認中…',
        'The desktop app is one way in, not the only one — on a server, run it in Docker or as a systemd service.': 'デスクトップアプリは入口のひとつにすぎません。サーバーではDockerかsystemdサービスとして動かせます。',
        "First launch shows a security warning? Here's how to open it": '初回起動でセキュリティ警告が出る？開き方はこちら',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'この警告はアプリがまだコード署名されていないためです。安全です。',
        'Running it on a server': 'サーバーで動かす',
        '🐧 Linux service (systemd)': '🐧 Linuxサービス（systemd）',
        'What it does': 'できること',
        'Every service is off until you turn it on. Turn on only what the site actually needs.': 'すべてのサービスは既定でオフです。その施設に本当に必要なものだけを有効にしてください。',
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
        'No high availability, no encryption at rest, no user accounts, no roles, and no per-user audit trail — the log records what happened, never who did it.': '冗長構成なし、保存時暗号化なし、ユーザーアカウントも権限もなし、ユーザー単位の監査証跡もありません。ログは「何が起きたか」を記録しますが、「誰がやったか」は記録できません。',
        'Not a replacement for your PACS or your RIS.': 'PACSやRISの置き換えではありません。',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'それらをつなぐゲートウェイであり、障害中も部門を動かし続け、復旧を待つための仕組みです。',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": '患者の診療がこれに依存するなら、その責任はソフトウェアではなく導入した側にあります。',
        'Up and running in 3 steps': '3ステップで使い始める',
        'Start it — desktop app in the tray, or a container/service on a server.': '起動する — トレイのデスクトップアプリ、またはサーバー上のコンテナ/サービスとして。',
        'Open the dashboard and pick which services this machine should run.': 'ダッシュボードを開き、このマシンで動かすサービスを選ぶ。',
        'Add your destinations, point the modalities at it, send a C-ECHO to confirm.': '送信先を追加し、モダリティを向けて、C-ECHOで疎通を確認する。',
        'Documentation': 'ドキュメント',
        'Full manuals: getting started, the security model and why the token rule exists, what each service does and when to turn it on.': '完全なマニュアル：導入手順、セキュリティモデルとトークン規則の理由、各サービスの役割と有効化の判断。',
        'Manual (English)': 'マニュアル（英語）',
        'For technical users': '技術者向け',
        '— DICOM details, CLI & source': '— DICOMの詳細・CLI・ソース',
        'Security policy': 'セキュリティポリシー',
        'Build & release': 'ビルドとリリース',
        'Not a medical device and not for primary diagnosis. Use TLS, set a token and restrict access before it touches real patient data.': '医療機器ではなく、一次読影にも使えません。実際の患者データを扱う前に、TLSを使い、トークンを設定し、アクセスを制限してください。',
        'Latest release:': '最新リリース:',
        'Latest release': '最新リリース',
        'has no installers yet —': 'にはまだインストーラーがありません —',
        'all versions & notes': '全バージョンとリリースノート',
        'see releases': 'リリース一覧を見る',
        'Version': 'バージョン',
        'Coming in v1.1.0': 'v1.1.0で追加されるもの',
        'Query/Retrieve SCP — C-FIND, C-MOVE and C-GET, so equipment that only speaks DIMSE can search this archive.': 'Query/Retrieve SCP — C-FIND・C-MOVE・C-GET。DIMSEしか話せない装置からでもこのアーカイブを検索できます。',
        'DICOMweb — QIDO-RS, WADO-RS and STOW-RS, so a browser viewer can read it without ever opening an association.': 'DICOMweb — QIDO-RS・WADO-RS・STOW-RS。ブラウザのビューアがアソシエーションを張らずに読み出せます。',
        'Conditional routing — send a study to different destinations by modality, calling AE, station, patient ID or study description.': '条件付きルーティング — モダリティ、呼び出し元AE、ステーション、患者ID、検査記述に応じて検査ごとに転送先を振り分けます。',
        'De-identification on forward — strip identity as studies leave, while the copy you keep stays untouched.': '転送時の匿名化 — 検査が出ていく際に識別情報を除去し、手元に残る原本はそのまま保持します。',
        'Token authentication — and a refusal to start at all if you expose the dashboard without one.': 'トークン認証 — トークンなしでダッシュボードを外部に公開しようとすると、そもそも起動を拒否します。',
        'Docker image, compose file and a hardened systemd unit, for running it on a server instead of a desktop.': 'Dockerイメージ、composeファイル、堅牢化したsystemdユニット。デスクトップではなくサーバーで動かすためのものです。',
        'Emergency RIS, Modality Worklist and automatic failover, for the hours your primary PACS is unreachable.': '緊急用RIS、Modality Worklist、自動フェイルオーバー。主PACSに到達できない時間帯のためのものです。',
        'Virtual print receiver, for modalities that can only print to film and never learned to C-STORE.': '仮想プリント受信。フィルムへの印刷しかできず、C-STOREを覚えなかったモダリティのために。',
    },
    ru: {
        'Late shift.': 'Ночная смена.',
        'Good morning.': 'Доброе утро.',
        'Good afternoon.': 'Добрый день.',
        'Good evening.': 'Добрый вечер.',
        'Your PACS systems are down? Urgent patients cannot wait.': 'PACS не работает? Экстренные пациенты не могут ждать.',
        'Keep the images moving,': 'Пусть изображения идут дальше,',
        'even when a system is down.': 'даже когда система лежит.',
        'recommended': 'рекомендуется',
        'Checking for the latest version…': 'Проверяем последнюю версию…',
        'The desktop app is one way in, not the only one — on a server, run it in Docker or as a systemd service.': 'Настольное приложение — лишь один из путей: на сервере запускайте его в Docker или как systemd-службу.',
        "First launch shows a security warning? Here's how to open it": 'При первом запуске появляется предупреждение безопасности? Вот как открыть',
        "The warning appears because the app isn't code-signed yet — it's safe.": 'Предупреждение появляется потому, что приложение ещё не имеет цифровой подписи — оно безопасно.',
        'Running it on a server': 'Запуск на сервере',
        '🐧 Linux service (systemd)': '🐧 Служба Linux (systemd)',
        'What it does': 'Что он делает',
        'Every service is off until you turn it on. Turn on only what the site actually needs.': 'Каждая служба выключена, пока вы её не включите. Включайте только то, что реально нужно отделению.',
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
        'No high availability, no encryption at rest, no user accounts, no roles, and no per-user audit trail — the log records what happened, never who did it.': 'Нет отказоустойчивости, нет шифрования на диске, нет учётных записей, ролей и пользовательского аудита — журнал пишет, что произошло, но никогда — кто это сделал.',
        'Not a replacement for your PACS or your RIS.': 'Он не заменяет ни PACS, ни RIS.',
        'It is the gateway between them, and the thing that keeps a department working through an outage until they come back.': 'Это шлюз между ними и то, что позволяет отделению работать во время аварии, пока они не вернутся.',
        "If a patient's care depends on it, the responsibility for that is yours, not this software's.": 'Если от этого зависит помощь пациенту, ответственность за это на вас, а не на программе.',
        'Up and running in 3 steps': 'Запуск за 3 шага',
        'Start it — desktop app in the tray, or a container/service on a server.': 'Запустите — настольное приложение в трее либо контейнер/служба на сервере.',
        'Open the dashboard and pick which services this machine should run.': 'Откройте панель и выберите, какие службы должна вести эта машина.',
        'Add your destinations, point the modalities at it, send a C-ECHO to confirm.': 'Добавьте адресатов, направьте на него модальности и проверьте связь через C-ECHO.',
        'Documentation': 'Документация',
        'Full manuals: getting started, the security model and why the token rule exists, what each service does and when to turn it on.': 'Полные руководства: первые шаги, модель безопасности и почему существует правило токена, что делает каждая служба и когда её включать.',
        'Manual (English)': 'Руководство (англ.)',
        'For technical users': 'Для технических специалистов',
        '— DICOM details, CLI & source': '— детали DICOM, CLI и исходный код',
        'Security policy': 'Политика безопасности',
        'Build & release': 'Сборка и релиз',
        'Not a medical device and not for primary diagnosis. Use TLS, set a token and restrict access before it touches real patient data.': 'Не медицинское изделие и не для первичной диагностики. Используйте TLS, задайте токен и ограничьте доступ, прежде чем работать с реальными данными пациентов.',
        'Latest release:': 'Последний релиз:',
        'Latest release': 'Последний релиз',
        'has no installers yet —': 'пока без установщиков —',
        'all versions & notes': 'все версии и заметки',
        'see releases': 'смотреть релизы',
        'Version': 'Версия',
        'Coming in v1.1.0': 'Что появится в v1.1.0',
        'Query/Retrieve SCP — C-FIND, C-MOVE and C-GET, so equipment that only speaks DIMSE can search this archive.': 'Query/Retrieve SCP — C-FIND, C-MOVE и C-GET, чтобы оборудование, знающее только DIMSE, могло искать в этом архиве.',
        'DICOMweb — QIDO-RS, WADO-RS and STOW-RS, so a browser viewer can read it without ever opening an association.': 'DICOMweb — QIDO-RS, WADO-RS и STOW-RS, чтобы браузерный просмотрщик читал архив, ни разу не открывая ассоциацию.',
        'Conditional routing — send a study to different destinations by modality, calling AE, station, patient ID or study description.': 'Условная маршрутизация — направляйте исследование разным адресатам по модальности, вызывающему AE, станции, ID пациента или описанию исследования.',
        'De-identification on forward — strip identity as studies leave, while the copy you keep stays untouched.': 'Обезличивание при пересылке — удаляет идентификацию на выходе, а хранимая у вас копия остаётся нетронутой.',
        'Token authentication — and a refusal to start at all if you expose the dashboard without one.': 'Аутентификация по токену — и отказ запускаться вовсе, если панель открыта наружу без него.',
        'Docker image, compose file and a hardened systemd unit, for running it on a server instead of a desktop.': 'Образ Docker, файл compose и усиленный systemd-юнит — чтобы запускать на сервере, а не на настольной машине.',
        'Emergency RIS, Modality Worklist and automatic failover, for the hours your primary PACS is unreachable.': 'Аварийная РИС, Modality Worklist и автоматическое переключение — на те часы, когда основной PACS недоступен.',
        'Virtual print receiver, for modalities that can only print to film and never learned to C-STORE.': 'Виртуальный приёмник печати — для модальностей, которые умеют только печатать на плёнку и так и не научились C-STORE.',
    },
};

// Rich blocks: paragraphs/list items mixing text with inline children.
// Keyed by CSS selector; values are full innerHTML per locale (en = original
// markup, restored from a snapshot captured on first pass). Inline tags and
// links mirror the English markup exactly.
const RICH = {
    '.lede': {
        es: '<strong>Carino PACS</strong> es una pasarela <abbr title="el formato y el protocolo estándar de las imágenes médicas de los equipos: rayos X, TC, RM, ecografía…">DICOM</abbr> autoalojada y un equipo de continuidad. Recibe estudios, los enruta y los reenvía, responde a <em>Query/Retrieve</em> y <em>DICOMweb</em>, y puede servir él mismo la worklist mientras tu PACS está inaccesible. Un archivo de configuración, un proceso, sin nube.',
        'pt-BR': '<strong>Carino PACS</strong> é um gateway <abbr title="o formato e o protocolo padrão das imagens médicas dos equipamentos: raio-X, TC, RM, ultrassom…">DICOM</abbr> auto-hospedado e um equipamento de continuidade. Recebe estudos, roteia e encaminha, responde a <em>Query/Retrieve</em> e <em>DICOMweb</em>, e pode servir a própria worklist enquanto o seu PACS está inacessível. Um arquivo de configuração, um processo, sem nuvem.',
        ja: '<strong>Carino PACS</strong> は自前で運用する<abbr title="X線・CT・MRI・超音波など医用画像の標準フォーマットおよび通信規格">DICOM</abbr>ゲートウェイであり、業務を止めないための装置です。検査を受信し、振り分けて転送し、<em>Query/Retrieve</em>と<em>DICOMweb</em>に応答し、PACSに届かない間はワークリストを自ら配信できます。設定ファイル1つ、プロセス1つ、クラウド不要。',
        ru: '<strong>Carino PACS</strong> — разворачиваемый у себя <abbr title="стандартный формат и сетевой протокол медицинских изображений: рентген, КТ, МРТ, УЗИ…">DICOM</abbr>-шлюз и устройство непрерывности работы. Он принимает исследования, маршрутизирует и пересылает их, отвечает на <em>Query/Retrieve</em> и <em>DICOMweb</em> и может сам раздавать рабочий список, пока ваш PACS недоступен. Один файл конфигурации, один процесс, без облака.',
    },
    '#q-docker': {
        es: 'El primer arranque imprime un token de acceso. Abre <code>http://127.0.0.1:8042/</code> y pégalo cuando el panel lo pida. Todo —configuración, estudios, logs, índice— vive en <code>./data</code>.',
        'pt-BR': 'A primeira inicialização imprime um token de acesso. Abra <code>http://127.0.0.1:8042/</code> e cole quando o painel pedir. Tudo — configuração, estudos, logs, índice — fica em <code>./data</code>.',
        ja: '初回起動時にアクセストークンが表示されます。<code>http://127.0.0.1:8042/</code> を開き、ダッシュボードに求められたら貼り付けてください。設定・検査データ・ログ・インデックスはすべて <code>./data</code> に置かれます。',
        ru: 'При первом запуске в журнал печатается токен доступа. Откройте <code>http://127.0.0.1:8042/</code> и вставьте его, когда панель попросит. Всё — конфигурация, исследования, журналы, индекс — лежит в <code>./data</code>.',
    },
    '#q-systemd': {
        es: 'El instalador lo deja todo listo y luego <em>se detiene</em>: arrancar un PACS abre puertos que aceptan datos de pacientes, así que esa decisión sigue siendo tuya. Edita <code>/var/lib/carino-pacs/config.json</code> y luego <code>systemctl start carino-pacs</code>.',
        'pt-BR': 'O instalador deixa tudo pronto e então <em>para</em>: iniciar um PACS abre portas que aceitam dados de pacientes, então essa decisão continua sendo sua. Edite <code>/var/lib/carino-pacs/config.json</code> e depois <code>systemctl start carino-pacs</code>.',
        ja: 'インストーラーは準備を終えたところで<em>停止します</em>。PACSを起動するとは、患者データを受け付けるリスナーを開くことなので、その判断は運用者に委ねられています。<code>/var/lib/carino-pacs/config.json</code> を編集してから <code>systemctl start carino-pacs</code> を実行してください。',
        ru: 'Установщик всё готовит и <em>останавливается</em>: запуск PACS открывает слушатели, принимающие данные пациентов, поэтому это решение остаётся за вами. Отредактируйте <code>/var/lib/carino-pacs/config.json</code>, затем <code>systemctl start carino-pacs</code>.',
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
    '#dl-release': {
        es: 'Los instaladores de arriba son la <b>v1.0.0</b>, que sólo almacena y reenvía. Todo lo demás que describe esta página ya está en <code>main</code> y saldrá en la <b>v1.1.0</b>: para usarlo hoy, ejecútalo con Docker o instálalo desde el código fuente.',
        'pt-BR': 'Os instaladores acima são a <b>v1.0.0</b>, que apenas armazena e encaminha. Todo o resto descrito nesta página já está no <code>main</code> e sai na <b>v1.1.0</b>: para usar hoje, rode com Docker ou instale a partir do código-fonte.',
        ja: '上のインストーラーは <b>v1.0.0</b> で、保存と転送しかできません。このページで説明している他の機能はすでに <code>main</code> にあり、<b>v1.1.0</b> で提供されます。今すぐ使うには Docker で動かすか、ソースからインストールしてください。',
        ru: 'Установщики выше — это <b>v1.0.0</b>, которая только принимает и пересылает. Всё остальное, описанное на этой странице, уже есть в <code>main</code> и выйдет в <b>v1.1.0</b>: чтобы пользоваться сейчас, запустите через Docker или установите из исходников.',
    },
    '#v11-intro': {
        es: 'Todo está escrito, probado y en <code>main</code>; lo que falta es una versión etiquetada con instaladores firmados. Úsalo hoy con Docker o desde el código fuente; la lista completa está en el <a href="https://github.com/MiguelCarino/Carino-PACS/blob/main/CHANGELOG.md" target="_blank" rel="noopener">registro de cambios</a>.',
        'pt-BR': 'Tudo já está escrito, testado e no <code>main</code>; o que falta é uma versão marcada com instaladores assinados. Use hoje com Docker ou a partir do código-fonte; a lista completa está no <a href="https://github.com/MiguelCarino/Carino-PACS/blob/main/CHANGELOG.md" target="_blank" rel="noopener">changelog</a>.',
        ja: 'いずれも実装・テスト済みで <code>main</code> に入っています。足りないのは、署名済みインストーラーを伴うタグ付きリリースだけです。今すぐ使うなら Docker かソースから。全一覧は<a href="https://github.com/MiguelCarino/Carino-PACS/blob/main/CHANGELOG.md" target="_blank" rel="noopener">変更履歴</a>にあります。',
        ru: 'Всё написано, протестировано и лежит в <code>main</code>; не хватает лишь тега релиза с подписанными установщиками. Пользуйтесь уже сегодня через Docker или из исходников; полный список — в <a href="https://github.com/MiguelCarino/Carino-PACS/blob/main/CHANGELOG.md" target="_blank" rel="noopener">списке изменений</a>.',
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
