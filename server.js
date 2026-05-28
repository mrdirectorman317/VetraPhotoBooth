const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const localIP = getLocalIP();
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(uploadsDir));

app.post('/api/upload', async (req, res) => {
  try {
    const { vertical, horizontal } = req.body;
    const id = uuidv4();
    const dir = path.join(uploadsDir, id);
    fs.mkdirSync(dir);

    const saveBase64 = (dataUrl, filename) => {
      const data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(path.join(dir, filename), Buffer.from(data, 'base64'));
    };

    saveBase64(vertical, 'vertical.jpg');
    saveBase64(horizontal, 'horizontal.jpg');

    const saveUrl = `http://${localIP}:${PORT}/save/${id}`;
    const qrDataUrl = await QRCode.toDataURL(saveUrl, {
      width: 320,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.json({ id, url: saveUrl, qr: qrDataUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/photos/:id', (req, res) => {
  const dir = path.join(uploadsDir, req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  res.json({
    vertical: `/uploads/${req.params.id}/vertical.jpg`,
    horizontal: `/uploads/${req.params.id}/horizontal.jpg`,
  });
});

app.get('/save/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'save.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎉  Vetra Photo Booth is running!');
  console.log(`👉  Open in browser: http://localhost:${PORT}`);
  console.log(`📱  Network (for QR):  http://${localIP}:${PORT}\n`);
});
