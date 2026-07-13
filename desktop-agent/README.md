# Lexora Masaüstü Ajanı

Seçtiğiniz klasörleri arka planda izler, yeni veya değişen hukuki belgeleri
(PDF, DOCX, DOC, TXT, RTF, ODT) otomatik olarak Lexora web uygulamasına yükler.
Yüklenen her dosya Lexora'nın **Belgeler** ekranında AI özeti ile birlikte görünür.

## Kurulum (kaynaktan çalıştırma)

```bash
cd desktop-agent
npm install
npm start
```

## Paketleme

```bash
# Kendi işletim sisteminiz için
npm run package:linux   # veya package:mac / package:win
```

Çıktı `desktop-agent/release/` klasöründe oluşur.

## Kullanım

1. Uygulamayı açın, Lexora hesabınızın e-posta ve şifresi ile giriş yapın.
2. **Klasör ekle** ile bilgisayarınızdaki dava klasörlerini seçin.
3. Ajan arka planda çalışır; sistem tepsisinden yönetilebilir.
4. Yeni dosyalar otomatik olarak Lexora'ya yüklenir ve AI tarafından özetlenir.

## Notlar

- 20MB üstü dosyalar atlanır.
- Her dosya `yol + boyut + değişim zamanı` ile takip edilir; aynı dosya tekrar yüklenmez.
- Google ile giriş yaptıysanız, önce Lexora'da e-posta/şifre belirleyin.
