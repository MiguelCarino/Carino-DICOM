// Create DICOM tab: build DICOM files from images, grouped into series.
// ---- Create DICOM ----
let createImages = [];

const SERIES_COLORS = ['#a78bfa','#22d3ee','#f472b6','#fb923c','#4ade80','#facc15','#f87171','#94a3b8'];
let createSeries = [{ id: 1, description: '', color: SERIES_COLORS[0] }];
let nextSeriesId = 2;

const createAddBtn   = $('createAddBtn');
const createSideAddBtn = $('createSideAddBtn');
const createFileInput  = $('createFileInput');
const createImgWrap  = $('createImgWrap');
const createImgGrid  = $('createImgGrid');
const createImgCount = $('createImgCount');
const clearCreateBtn = $('clearCreateBtn');
const createSideDropZone = $('createSideDropZone');
const createDicomBtn = $('createDicomBtn');

(function() {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  $('cdStudyDate').value = iso;
})();

function addCreateImages(files) {
  const exts = /\.(png|jpe?g|bmp|gif|webp|tiff?)$/i;
  for (const f of files) {
    if (!f.type.startsWith('image/') && !exts.test(f.name)) continue;
    createImages.push({ file: f, objectURL: URL.createObjectURL(f), series: createSeries[0].id });
  }
  renderCreateGrid();
}

function removeCreateImage(idx) {
  URL.revokeObjectURL(createImages[idx].objectURL);
  createImages.splice(idx, 1);
  renderCreateGrid();
}

function seriesColor(id) {
  const s = createSeries.find(s => s.id === id);
  return s ? s.color : '#94a3b8';
}

function renderSeriesPanel() {
  const container = $('seriesList');
  if (!container) return;
  container.innerHTML = '';
  createSeries.forEach(s => {
    const row = document.createElement('div');
    row.className = 'series-item';

    const dot = document.createElement('span');
    dot.className = 'series-dot';
    dot.style.background = s.color;

    const label = document.createElement('span');
    label.className = 'series-label';
    label.textContent = `S${s.id}`;

    const input = document.createElement('input');
    input.className = 'form-input';
    input.style.cssText = 'flex:1;font-size:12px;padding:5px 8px';
    input.placeholder = T('Description');
    input.value = s.description;
    input.addEventListener('input', () => { s.description = input.value; });

    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(input);

    if (createSeries.length > 1) {
      const rm = document.createElement('button');
      rm.className = 'series-rm-btn';
      rm.title = 'Remove series';
      rm.textContent = '✕';
      rm.addEventListener('click', () => removeSeries(s.id));
      row.appendChild(rm);
    }

    container.appendChild(row);
  });
}

function addSeries() {
  const color = SERIES_COLORS[createSeries.length % SERIES_COLORS.length];
  createSeries.push({ id: nextSeriesId++, description: '', color });
  renderSeriesPanel();
  renderCreateGrid();
}

function removeSeries(id) {
  if (createSeries.length <= 1) return;
  createSeries = createSeries.filter(s => s.id !== id);
  const fallbackId = createSeries[0].id;
  createImages.forEach(img => { if (img.series === id) img.series = fallbackId; });
  renderSeriesPanel();
  renderCreateGrid();
}

function renderCreateGrid() {
  createImgCount.textContent = `${createImages.length} image${createImages.length !== 1 ? 's' : ''}`;
  if (!createImages.length) {
    createImgGrid.innerHTML = `
      <div class="img-empty">
        <div class="img-empty-icon">🖼</div>
        <span>${T('Drop images here or click "+ Add Images"')}</span>
        <span class="img-empty-hint">${T('PNG · JPEG · BMP · WebP supported')}</span>
      </div>`;
    return;
  }
  createImgGrid.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'img-grid';
  createImages.forEach((img, i) => {
    const div = document.createElement('div');
    div.className = 'img-thumb';

    const image = document.createElement('img');
    image.src = img.objectURL;
    image.alt = img.file.name;

    const info = document.createElement('div');
    info.className = 'img-thumb-info';
    info.textContent = img.file.name;

    const rmBtn = document.createElement('button');
    rmBtn.className = 'img-thumb-remove';
    rmBtn.title = 'Remove';
    rmBtn.textContent = '✕';
    rmBtn.addEventListener('click', e => { e.stopPropagation(); removeCreateImage(i); });

    const sel = document.createElement('select');
    sel.className = 'img-thumb-series';
    sel.title = 'Assign series';
    sel.style.background = seriesColor(img.series) + 'cc';
    createSeries.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `S${s.id}`;
      if (img.series === s.id) opt.selected = true;
      sel.appendChild(opt);
    });
    const newOpt = document.createElement('option');
    newOpt.value = 'new';
    newOpt.textContent = T('+ New');
    sel.appendChild(newOpt);

    sel.addEventListener('change', () => {
      if (sel.value === 'new') {
        addSeries();
        createImages[i].series = createSeries[createSeries.length - 1].id;
      } else {
        createImages[i].series = parseInt(sel.value);
      }
      renderCreateGrid();
    });

    div.appendChild(image);
    div.appendChild(info);
    div.appendChild(rmBtn);
    div.appendChild(sel);
    grid.appendChild(div);
  });
  createImgGrid.appendChild(grid);
}

createAddBtn.addEventListener('click', () => createFileInput.click());
createSideAddBtn.addEventListener('click', () => createFileInput.click());
createSideDropZone.addEventListener('click', () => createFileInput.click());
createFileInput.addEventListener('change', e => {
  if (e.target.files?.length) addCreateImages(Array.from(e.target.files));
  e.target.value = '';
});
clearCreateBtn.addEventListener('click', () => {
  createImages.forEach(img => URL.revokeObjectURL(img.objectURL));
  createImages = [];
  createSeries = [{ id: 1, description: '', color: SERIES_COLORS[0] }];
  nextSeriesId = 2;
  renderCreateGrid();
  renderSeriesPanel();
  toast?.('Cleared all images');
});

createSideDropZone.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
createSideDropZone.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  // Folders work too; addCreateImages filters out non-image files.
  collectDropped(e.dataTransfer)?.then(r => addCreateImages(r.items.map(it => it.file)));
});

async function buildDicomFromImage(file, meta, instanceNum) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width  = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const rows = canvas.height;
  const cols = canvas.width;
  const rgba = ctx.getImageData(0, 0, cols, rows).data;

  // DICOM OB values must be even-length; pad with a null byte if needed.
  const pixBytes = rows * cols * 3;
  const rgb = new Uint8Array(pixBytes % 2 === 0 ? pixBytes : pixBytes + 1);
  for (let i = 0; i < rows * cols; i++) {
    rgb[i * 3]     = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }

  const sopInstanceUID = newUID();

  // Keys must be 8-char uppercase hex, no 'x': dcmjs Tag.fromString parseInt()s substring(0,4).
  const d = {
    '00080005': { vr: 'CS', Value: ['ISO_IR 192'] },
    '00080008': { vr: 'CS', Value: ['ORIGINAL', 'PRIMARY'] },
    '00080016': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.7'] },
    '00080018': { vr: 'UI', Value: [sopInstanceUID] },
    '00080020': { vr: 'DA', Value: [meta.studyDate] },
    '00080021': { vr: 'DA', Value: [meta.studyDate] },
    '00080022': { vr: 'DA', Value: [meta.studyDate] },
    '00080023': { vr: 'DA', Value: [meta.studyDate] },
    '00080030': { vr: 'TM', Value: [meta.studyTime] },
    '00080031': { vr: 'TM', Value: [meta.studyTime] },
    '00080032': { vr: 'TM', Value: [meta.studyTime] },
    '00080033': { vr: 'TM', Value: [meta.studyTime] },
    '00080060': { vr: 'CS', Value: [meta.modality] },
    '00081030': { vr: 'LO', Value: [meta.studyDescription] },
    '0008103E': { vr: 'LO', Value: [meta.seriesDescription] },
    '00100010': { vr: 'PN', Value: [meta.patientName] },
    '00100020': { vr: 'LO', Value: [meta.patientID] },
    '00100030': { vr: 'DA', Value: [meta.patientDOB] },
    '00100040': { vr: 'CS', Value: [meta.patientSex] },
    '0020000D': { vr: 'UI', Value: [meta.studyUID] },
    '0020000E': { vr: 'UI', Value: [meta.seriesUID] },
    '00200010': { vr: 'SH', Value: ['1'] },
    '00200011': { vr: 'IS', Value: [1] },
    '00200012': { vr: 'IS', Value: [instanceNum] },
    '00200013': { vr: 'IS', Value: [instanceNum] },
    '00280002': { vr: 'US', Value: [3] },
    '00280004': { vr: 'CS', Value: ['RGB'] },
    '00280006': { vr: 'US', Value: [0] },
    '00280010': { vr: 'US', Value: [rows] },
    '00280011': { vr: 'US', Value: [cols] },
    '00280100': { vr: 'US', Value: [8] },
    '00280101': { vr: 'US', Value: [8] },
    '00280102': { vr: 'US', Value: [7] },
    '00280103': { vr: 'US', Value: [0] },
    '7FE00010': { vr: 'OB', Value: [rgb.buffer] },
  };

  // Meta also needs plain 8-char hex keys — DicomDict.write() checks meta["00020010"]
  const fileMeta = {
    '00020002': { vr: 'UI', Value: ['1.2.840.10008.5.1.4.1.1.7'] },
    '00020003': { vr: 'UI', Value: [sopInstanceUID] },
    '00020010': { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] },
    '00020012': { vr: 'UI', Value: ['1.2.826.0.1.3680043.10.743'] },
  };

  const dd = new DicomDict(fileMeta);
  dd.dict = d;
  const out = dd.write();
  return out.buffer || out;
}

// ---- Quick-fill helpers ----
// Same split as the Edit tab: Anonymize fills placeholders, Randomize invents a plausible patient.
function fillCreateAnon() {
  $('cdPatientName').value = ANON_NAME;
  $('cdPatientID').value   = 'ANON';
  $('cdPatientDOB').value  = '';
  $('cdPatientSex').value  = 'O';
  $('cdStudyDate').value   = new Date().toISOString().slice(0, 10);
  $('cdStudyDesc').value   = '';
}

function fillCreateRandom() {
  const year  = 1950 + Math.floor(Math.random() * 60);
  const month = String(1  + Math.floor(Math.random() * 12)).padStart(2, '0');
  const day   = String(1  + Math.floor(Math.random() * 28)).padStart(2, '0');
  const sex   = randFrom(['M', 'F', 'O']);
  $('cdPatientName').value = randName(sex);
  $('cdPatientID').value   = randDigits(8);
  $('cdPatientDOB').value  = `${year}-${month}-${day}`;
  $('cdPatientSex').value  = sex;
  $('cdStudyDate').value   = new Date().toISOString().slice(0, 10);
  $('cdStudyDesc').value   = randFrom(['CHEST X-RAY', 'MRI BRAIN', 'CT ABDOMEN', 'US PELVIS', 'MAMMOGRAM']);
}

$('cdAnonymizeBtn').addEventListener('click', fillCreateAnon);
$('cdRandomizeBtn').addEventListener('click', fillCreateRandom);
$('addSeriesBtn').addEventListener('click', addSeries);

renderSeriesPanel();

