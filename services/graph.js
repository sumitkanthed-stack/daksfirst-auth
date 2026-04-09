const config = require('../config');

async function getGraphToken() {
  try {
    const tokenUrl = `https://login.microsoftonline.com/${config.AZURE_TENANT_ID}/oauth2/v2.0/token`;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.AZURE_CLIENT_ID,
        client_secret: config.AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token request failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.access_token;
  } catch (err) {
    console.error('[graph] Token fetch failed:', err.message);
    throw err;
  }
}

async function uploadFileToOneDrive(token, dealRef, filename, fileBuffer) {
  try {
    const encodedFilename = encodeURIComponent(filename);
    const uploadUrl = `https://graph.microsoft.com/v1.0/users/${config.GRAPH_USER_EMAIL}/drive/root:/${config.ONEDRIVE_ROOT}/${dealRef}/${encodedFilename}:/content`;

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      },
      body: fileBuffer
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed: ${response.status} ${text.substring(0, 200)}`);
    }

    const data = await response.json();
    return {
      itemId: data.id,
      path: data.parentReference?.path,
      downloadUrl: data.webUrl
    };
  } catch (err) {
    console.error('[graph] Upload failed:', err.message);
    throw err;
  }
}

module.exports = {
  getGraphToken,
  uploadFileToOneDrive
};
