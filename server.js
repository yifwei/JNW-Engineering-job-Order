const http = require('http');
const https = require('https');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { translateToEnglish } = require('./translation');

const PORT = Number(process.env.PORT || 4322);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const REPORTS_DIR = path.resolve(process.env.REPORTS_DIR || path.join(ROOT, 'Reports'));
const sequence = require('./sequence')(REPORTS_DIR);
const SEQUENCE_FILE = path.join(REPORTS_DIR, '.sequence.json');
const LOG_FILE = path.join(REPORTS_DIR, 'Job_Order_Log.csv');

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_ONEDRIVE_SITE_ID = process.env.GRAPH_ONEDRIVE_SITE_ID
  || 'jnwengineering-my.sharepoint.com,93983fb9-90e8-4aae-a4dd-87c3eb396f02,58b5320c-42b8-4018-b508-1ab09a838e88';
const GRAPH_ONEDRIVE_DRIVE_ID = process.env.GRAPH_ONEDRIVE_DRIVE_ID || '';
const GRAPH_ONEDRIVE_FOLDER_ID = process.env.GRAPH_ONEDRIVE_FOLDER_ID || '';
const GRAPH_ONEDRIVE_FOLDER_PATH = process.env.GRAPH_ONEDRIVE_FOLDER_PATH || '{year}';

let graphTokenCache = null;
let graphDriveCache = null;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const readBody = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 20 * 1024 * 1024) {
      reject(new Error('Submission is too large.'));
      request.destroy();
    }
  });
  request.on('end', () => resolve(body));
  request.on('error', reject);
});

const ensureReportsDir = async () => {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
};

const readSequence = sequence.read;

const formatJobOrder = (number) => String(Math.max(1, Number(number) || 1)).padStart(2, '0');

const csvCell = (value) => `"${String(value || '').replaceAll('"', '""')}"`;

const cleanFilePart = (value) => String(value || '')
  .trim()
  .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
  .replace(/\s+/g, ' ')
  .slice(0, 60);

const formatDateForFile = (value, fallbackDate = new Date()) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}-${match[2]}-${match[1]}`;

  const parsed = value ? new Date(value) : fallbackDate;
  if (Number.isNaN(parsed.getTime())) return fallbackDate.toISOString().slice(0, 10);
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = parsed.getFullYear();
  return `${day}-${month}-${year}`;
};

const getReportYear = (value, fallbackDate = new Date()) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return match[1];

  const parsed = value ? new Date(value) : fallbackDate;
  const date = Number.isNaN(parsed.getTime()) ? fallbackDate : parsed;
  return String(date.getFullYear());
};

const buildReportFolderPath = (data) => GRAPH_ONEDRIVE_FOLDER_PATH
  .replaceAll('{year}', getReportYear(data.date, new Date(data.submittedAt)))
  .replaceAll('{yyyy}', getReportYear(data.date, new Date(data.submittedAt)));

const normaliseParts = (parts) => Array.isArray(parts)
  ? parts.map((part, index) => ({
      serial: part.serial || String(index + 1),
      description: part.description || '',
      quantity: part.quantity || part.charge || '',
    })).filter((part) => part.description || part.quantity)
  : [];

const webRequest = (url, options = {}) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const body = options.body
    ? (Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body)))
    : null;

  const request = transport.request(target, {
    method: options.method || 'GET',
    headers: {
      ...(options.headers || {}),
      ...(body ? { 'Content-Length': body.length } : {}),
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        text: () => Promise.resolve(buffer.toString('utf8')),
        json: () => Promise.resolve(JSON.parse(buffer.toString('utf8'))),
      });
    });
  });

  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

const pdfEscape = (value) => String(value || '')
  .replace(/\\/g, '\\\\')
  .replace(/\(/g, '\\(')
  .replace(/\)/g, '\\)')
  .replace(/\r?\n/g, ' ');

const wrapText = (value, maxChars = 88) => {
  const words = String(value || '').replace(/\r?\n/g, ' ').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    if ((line + ' ' + word).trim().length > maxChars) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const createPdfBuffer = require('./pdf-report');

const getGraphToken = async () => {
  if (graphTokenCache && graphTokenCache.expiresOn > Date.now() + 120000) {
    return graphTokenCache.token;
  }

  const resource = encodeURIComponent('https://graph.microsoft.com/');
  const identityEndpoint = process.env.IDENTITY_ENDPOINT || process.env.MSI_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER || process.env.MSI_SECRET;
  const tokenUrl = identityEndpoint
    ? `${identityEndpoint}?api-version=2019-08-01&resource=${resource}`
    : `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${resource}`;
  const response = await webRequest(tokenUrl, {
    headers: identityEndpoint
      ? { 'X-IDENTITY-HEADER': identityHeader }
      : { Metadata: 'true' },
  });

  if (!response.ok) {
    throw new Error(`Could not get Azure identity token (${response.status}).`);
  }

  const token = await response.json();
  graphTokenCache = {
    token: token.access_token,
    expiresOn: Number(token.expires_on) * 1000,
  };
  return graphTokenCache.token;
};

const graphRequest = async (url, options = {}) => {
  const token = await getGraphToken();
  const response = await webRequest(`${GRAPH_BASE_URL}${url}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (response.ok) {
    if (response.status === 204) return null;
    return response.json();
  }

  const detail = await response.text();
  throw new Error(`OneDrive upload failed (${response.status}). ${detail}`);
};

const encodeSharePointPath = (value) => String(value)
  .split('/')
  .filter(Boolean)
  .map(encodeURIComponent)
  .join('/');

const resolveDrive = async () => {
  if (graphDriveCache) return graphDriveCache;

  if (GRAPH_ONEDRIVE_DRIVE_ID) {
    const drive = await graphRequest(`/drives/${GRAPH_ONEDRIVE_DRIVE_ID}`);
    graphDriveCache = { driveId: drive.id, libraryName: 'My files' };
    return graphDriveCache;
  }

  const drive = await graphRequest(`/sites/${GRAPH_ONEDRIVE_SITE_ID}/drive`);

  if (!drive?.id) {
    throw new Error('Could not find the configured OneDrive.');
  }

  graphDriveCache = {
    siteId: GRAPH_ONEDRIVE_SITE_ID,
    driveId: drive.id,
    libraryName: 'My files',
  };
  return graphDriveCache;
};

const checkOneDriveConnection = async () => {
  const { driveId } = await resolveDrive();
  const date = new Date().toISOString();
  const reportYear = getReportYear(date.slice(0, 10), new Date(date));
  const folderPath = `${buildReportFolderPath({ date: date.slice(0, 10), submittedAt: date }).replace(/\/+$/, '')}/Online JO/${reportYear}`;
  const item = await graphRequest(`/drives/${driveId}/root:/${encodeSharePointPath(folderPath)}:`);
  if (!item?.folder) throw new Error('Configured OneDrive report folder is not available.');
  return { ok: true };
};

const ensureFolderPath = async (driveId, folderPath) => {
  const parts = String(folderPath || '').split('/').map((part) => part.trim()).filter(Boolean);
  let currentPath = '';

  for (const part of parts) {
    const parentPath = currentPath ? `root:/${encodeSharePointPath(currentPath)}:` : 'root';
    try {
      await graphRequest(`/drives/${driveId}/${parentPath}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: part,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'fail',
        }),
      });
    } catch (error) {
      if (!String(error.message).includes('nameAlreadyExists')) throw error;
    }
    currentPath = currentPath ? `${currentPath}/${part}` : part;
  }
};

const uploadPdfToOneDrive = async (fileName, pdfBuffer, folderPath, reportYear) => {
  const { driveId } = await resolveDrive();
  let uploadUrl;
  if (GRAPH_ONEDRIVE_FOLDER_ID) {
    let destinationId = GRAPH_ONEDRIVE_FOLDER_ID;
    for (const name of ['Online JO', reportYear]) {
    const parent = `/drives/${driveId}/items/${encodeURIComponent(destinationId)}`;
    let folder;
    try {
      folder = await graphRequest(`${parent}/children`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
    } catch (error) {
      if (!String(error.message).includes('nameAlreadyExists')) throw error;
      folder = await graphRequest(`${parent}:/${encodeURIComponent(name)}`);
    }
    if (!folder?.id || !folder.folder) throw new Error('Online JO destination is not a folder.');
    destinationId = folder.id;
    }
    uploadUrl = `/drives/${driveId}/items/${encodeURIComponent(destinationId)}:/${encodeURIComponent(fileName)}:/content`;
  } else {
    await ensureFolderPath(driveId, folderPath);
    const uploadPath = encodeSharePointPath(`${folderPath}/${fileName}`);
    uploadUrl = `/drives/${driveId}/root:/${uploadPath}:/content`;
  }
  return graphRequest(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBuffer,
  });
};

const appendCsv = async (data, pdfFile, jsonFile) => {
  await ensureReportsDir();
  const exists = await fs.access(LOG_FILE).then(() => true).catch(() => false);
  if (!exists) {
    await fs.writeFile(LOG_FILE, [
      'Submitted At',
      'Job Order',
      'Company',
      'Date',
      'Requested By',
      'Complaint',
      'Action Taken',
      'Materials',
      'Labour Description',
      'Man',
      'Hours',
      'Remarks',
      'PDF File',
      'JSON File',
    ].map(csvCell).join(',') + os.EOL);
  }

  const materials = normaliseParts(data.parts)
    .map((part) => `${part.serial}. ${part.description} x ${part.quantity}`)
    .join(' | ');

  await fs.appendFile(LOG_FILE, [
    data.submittedAt,
    data.jobOrder,
    data.company,
    data.date,
    data.requestedBy,
    data.complaint,
    data.actionTaken,
    materials,
    data.labourDescription,
    data.labourMan,
    data.labourHours,
    data.remarks,
    pdfFile,
    jsonFile,
  ].map(csvCell).join(',') + os.EOL);
};

const saveLocalBackup = async (jsonFile, data, pdfFile, pdfBuffer) => {
  await ensureReportsDir();
  await fs.writeFile(path.join(REPORTS_DIR, jsonFile), JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(path.join(REPORTS_DIR, pdfFile), pdfBuffer, { flag: 'wx' });
};

const saveSubmission = async (payload) => {
  const nextNumber = await sequence.reserve();
  const jobOrder = formatJobOrder(nextNumber);
  const nextJobOrder = nextNumber + 1;
  const submittedAt = new Date().toISOString();
  const companyPart = cleanFilePart(payload.company) || 'No Company';
  const datePart = formatDateForFile(payload.date, new Date(submittedAt));
  const baseName = `JO ${jobOrder} _ ${companyPart} _ ${datePart}`;
  const jsonFile = `${baseName}.json`;
  const pdfFile = `${baseName}.pdf`;
  const data = { ...payload, jobOrder, submittedAt };

  const pdfBuffer = await createPdfBuffer(data);
  const reportYear = getReportYear(data.date, new Date(submittedAt));
  const reportFolderPath = `${buildReportFolderPath(data).replace(/\/+$/, '')}/Online JO/${reportYear}`;
  const uploadedFile = await uploadPdfToOneDrive(pdfFile, pdfBuffer, reportFolderPath, reportYear);
  await saveLocalBackup(jsonFile, data, pdfFile, pdfBuffer);
  await appendCsv(data, pdfFile, jsonFile);


  return {
    jobOrder,
    nextJobOrder: formatJobOrder(nextJobOrder),
    pdfFile,
    pdfUrl: `/api/reports/${encodeURIComponent(pdfFile)}`,
    oneDriveFolder: `${graphDriveCache?.libraryName || 'My files'}/${reportFolderPath}`,
    webUrl: uploadedFile.webUrl,
  };
};

const serveReportPdf = async (request, response, pathname) => {
  let fileName;
  try {
    fileName = decodeURIComponent(pathname.slice('/api/reports/'.length));
  } catch {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  if (!/^[\w .-]+\.pdf$/i.test(fileName) || path.basename(fileName) !== fileName) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const file = await fs.readFile(path.join(REPORTS_DIR, fileName));
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName.replaceAll('"', '')}"`,
      'Cache-Control': 'private, no-store',
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
};

const listSharedHistory = async () => {
  await ensureReportsDir();
  const files = await fs.readdir(REPORTS_DIR, { withFileTypes: true });
  const reports = await Promise.all(files
    .filter((file) => file.isFile() && file.name.toLowerCase().endsWith('.json') && !file.name.startsWith('.'))
    .map(async (file) => {
      try {
        const data = JSON.parse(await fs.readFile(path.join(REPORTS_DIR, file.name), 'utf8'));
        const { signatures, ...report } = data;
        const pdfFile = `${file.name.slice(0, -'.json'.length)}.pdf`;
        return {
          ...report,
          savedAt: report.submittedAt || '',
          pdfFile,
          pdfUrl: `/api/reports/${encodeURIComponent(pdfFile)}`,
        };
      } catch {
        return null;
      }
    }));

  return reports
    .filter(Boolean)
    .sort((left, right) => Number(right.jobOrder) - Number(left.jobOrder))
    .slice(0, 200);
};

const serveStatic = async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const publicFiles = new Map([
    ['/translate-form.js', 'translate-form.js'],
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/JNW.png', 'JNW.png'],
    ['/manifest.webmanifest', 'manifest.webmanifest'],
    ['/service-worker.js', 'service-worker.js'],
    ['/jnw-job-order-icon.svg', 'jnw-job-order-icon.svg'],
  ]);
  const publicFile = publicFiles.get(url.pathname);
  if (!publicFile) {
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end('Not found');
    return;
  }
  const filePath = path.join(ROOT, publicFile);

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/api/translate') {
      try {
        let payload;
        try { payload = JSON.parse(await readBody(request)); }
        catch { json(response, 400, { error: 'Invalid translation request.' }); return; }
        json(response, 200, await translateToEnglish(payload));
      } catch (error) {
        json(response, error.status || 502, { error: error.status ? error.message : 'Translation failed. Your text has been kept.' });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/next-job-order') {
      json(response, 200, { nextJobOrder: formatJobOrder(await readSequence()) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/one-drive-health') {
      json(response, 200, await checkOneDriveConnection());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/history') {
    if (!process.env.HISTORY_ACCESS_PIN || request.headers['x-history-pin'] !== process.env.HISTORY_ACCESS_PIN) {
      json(response, 401, { error: 'History access PIN is required.' });
      return;
    }
      json(response, 200, { reports: await listSharedHistory() });
      return;
    }

    if (request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/api/submit') {
      const payload = JSON.parse(await readBody(request));
      json(response, 200, await saveSubmission(payload));
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
      await serveReportPdf(request, response, url.pathname);
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response);
      return;
    }

    response.writeHead(405);
    response.end('Method not allowed');
  } catch (error) {
    console.error('Request failed:', error);
    json(response, 500, { error: 'Unable to complete the request. Please contact the administrator.' });
  }
});

if (require.main === module) server.listen(PORT, HOST, () => {
  console.log(`JNW Job Order server running at http://localhost:${PORT}/`);
  console.log(`Reports upload to: My files/${GRAPH_ONEDRIVE_FOLDER_PATH}/Online JO/{job year}`);
});

module.exports = { server };
