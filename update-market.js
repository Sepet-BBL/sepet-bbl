const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Ayarları
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
    : undefined,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  try {
    const apiToken = process.env.EODHD_API_TOKEN;
    if (!apiToken) throw new Error("API Token bulunamadı!");

    console.log("🌍 Borsa İstanbul Listesi Çekiliyor...");

    // ADIM 1: Tüm Borsa İstanbul (IS) Şirketlerini Otomatik Çek
    // Bu link, o an borsada olan tüm şirketleri listeler (Halka arzlar dahil).
    const listUrl = `https://eodhd.com/api/exchanges/IS?api_token=${apiToken}&fmt=json`;
    const listResponse = await axios.get(listUrl);
    
    // Sadece "Common Stock" (Hisse Senedi) olanları al, fonları vb. ele.
    const allSymbols = listResponse.data
        .filter(item => item.Type === 'Common Stock')
        .map(item => item.Code); // Sadece kodları al (Örn: THYAO, GARAN)

    console.log(`📋 Toplam ${allSymbols.length} adet hisse bulundu.`);

    // ADIM 2: Listeyi 30'arlı Paketlere Böl (URL çok uzamasın diye)
    const chunkSize = 30;
    const chunks = [];
    for (let i = 0; i < allSymbols.length; i += chunkSize) {
      chunks.push(allSymbols.slice(i, i + chunkSize));
    }

    console.log(`📦 İşlem ${chunks.length} pakete bölündü, veriler çekiliyor...`);

    let totalUpdated = 0;
    const batch = db.batch(); // Firestore Toplu Yazma
    let batchCount = 0;

    // Tüm paketleri aynı anda iste (Hızlandırmak için)
    const promises = chunks.map(async (chunk) => {
      const first = chunk[0];
      const others = chunk.slice(1).join(',');
      // Real-Time API ile çoklu sorgu
      const url = `https://eodhd.com/api/real-time/${first}?api_token=${apiToken}&s=${others}&fmt=json`;
      
      try {
        const res = await axios.get(url);
        return Array.isArray(res.data) ? res.data : [res.data];
      } catch (err) {
        console.error(`⚠️ Paket hatası: ${err.message}`);
        return [];
      }
    });

    // API Yanıtlarını Bekle
    const results = await Promise.all(promises);
    const allStocksData = results.flat(); // Gelen verileri tek listede birleştir

    // ADIM 3: Veritabanına Kaydet
    allStocksData.forEach(stock => {
      const rawCode = stock.code || stock.Code;
      if (!rawCode) return;
      
      const symbol = rawCode.split('.')[0]; // "THYAO.IS" -> "THYAO" yap
      const price = stock.close || stock.Close || stock.previousClose;
      const date = new Date().toISOString().split('T')[0];

      if (price) {
        const docRef = db.collection('sepet').doc(symbol);
        batch.set(docRef, {
          symbol: symbol,
          fiyat: parseFloat(price),
          sonGuncelleme: date,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        batchCount++;
        totalUpdated++;
      }
    });

    // Veritabanına "Commit" et (Yaz)
    if (batchCount > 0) {
      await batch.commit();
    }

    console.log(`✅ Başarılı! Toplam ${totalUpdated} hisse güncellendi.`);
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Otomatik Güncelleme Tamamlandı", count: totalUpdated })
    };

  } catch (error) {
    console.error("❌ Kritik Hata:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};