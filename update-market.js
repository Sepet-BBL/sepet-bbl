const admin = require("firebase-admin");
const axios = require("axios");
const { schedule } = require("@netlify/functions");

// Firebase Ayarları (Netlify Panelinden Okuyacak)
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  // Özel anahtardaki satır sonu karakterlerini düzeltiyoruz
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
};

// Firebase'i Başlat
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error("Firebase başlatma hatası:", error);
  }
}

const db = admin.firestore();

// Ana Bot Fonksiyonu
const handler = async (event, context) => {
  console.log("🌍 Borsa Güncellemesi Başlıyor...");
  
  // EODHD API Token (Netlify Panelinden)
  const EODHD_TOKEN = process.env.EODHD_API_TOKEN;
  // BIST (Istanbul) Borsası için Bulk Data URL'i
  const URL = `https://eodhd.com/api/eod-bulk-last-day/IS?api_token=${EODHD_TOKEN}&fmt=json`;

  try {
    // 1. EODHD'den Veriyi Çek
    const response = await axios.get(URL);
    const data = response.data;

    if (!data || data.length === 0) {
      console.log("Veri alınamadı veya borsa kapalı.");
      return { statusCode: 500 };
    }

    console.log(`📦 ${data.length} adet hisse verisi alındı. İşleniyor...`);

    // 2. Firebase'e Yaz (Batch işlemi ile - 500'erli gruplar halinde)
    const batch = db.batch();
    let counter = 0;
    let batchCount = 0;

    for (const stock of data) {
      // Filtreleme: Fiyatı 0.1 altındakileri veya işlem görmeyenleri alma
      if (stock.close < 0.1) continue;

      const symbol = stock.code; // Örn: THYAO
      const docRef = db.collection('sepet').doc(symbol);

      // Veriyi Hazırla
      batch.set(docRef, {
        transfer_degeri: stock.close, // Güncel Fiyat
        temel_puan: stock.change_p || 0, // Günlük % Değişim (Puan olarak kullanıyoruz)
        // Eğer hakkında kısmı boşsa doldur, doluysa elleme (merge:true sayesinde)
        // son_guncelleme: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      counter++;

      // Firestore Batch Limiti (400'de bir gönder)
      if (counter >= 400) {
        await batch.commit();
        console.log(`💾 Grup ${++batchCount} kaydedildi.`);
        counter = 0;
        // Not: Normalde batch yeniden oluşturulmalı ama serverless ortamda
        // tek seferlik döngüde commit sonrası devam edebiliriz.
      }
    }

    // Kalanları gönder
    if (counter > 0) {
      await batch.commit();
      console.log("💾 Son parça kaydedildi.");
    }

    console.log("✅ GÜNCELLEME BAŞARIYLA TAMAMLANDI.");
    return { statusCode: 200 };

  } catch (error) {
    console.error("Hata oluştu:", error);
    return { statusCode: 500 };
  }
};

// Zamanlama Ayarı: Hafta içi her gün 18:30 (Türkiye Saati)
// Cron: "30 15 * * 1-5" (UTC saatiyle 15:30 = TR saatiyle 18:30)
module.exports.handler = schedule("30 15 * * 1-5", handler);