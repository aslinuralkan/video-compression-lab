# Video Compression Lab

Video Compression Lab, videoları tarayıcıya veya RAM'e bütünüyle almadan yerel diske yükleyen ve backend tarafında CPU üzerinde FFmpeg `libx264` ile sıkıştıran küçük, bağımsız bir uygulamadır. Sunucu yalnızca `127.0.0.1` üzerinde dinler. GPU, donanım hızlandırma ve ffmpeg.wasm kullanılmaz.

## Gereksinimler

- Node.js 20 veya daha yeni
- `ffmpeg` ve `ffprobe` komutlarının PATH üzerinde bulunması
- FFmpeg içinde `libx264` encoder desteği
- VMAF için isteğe bağlı `libvmaf` filter desteği
- Büyük videolarda kaynak, geçici çıktı ve güvenlik payı için yeterli boş disk alanı

Kurulumu doğrulayın:

```bash
node --version
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders | grep libx264
ffmpeg -hide_banner -filters | grep libvmaf
```

`libvmaf` bulunmuyorsa uygulama sahte skor üretmez; açık bir uyarı gösterir ve kalite ölçümünü SSIM + PSNR fallback olarak yapar.

### macOS

[Homebrew'un güncel FFmpeg formülü](https://formulae.brew.sh/formula/ffmpeg.html) ile kurulum:

```bash
brew install ffmpeg
```

Güncel standart formül `x264` ve `libvmaf` bağımlılıklarını listeler; yine de etkin filter'ı yukarıdaki komutla doğrulayın. İçermeyen farklı/eski bir paket kullanıyorsanız `libvmaf` etkin (`--enable-libvmaf`) bir FFmpeg dağıtımı veya kaynak derlemesi gerekir. Özel binary yolları `FFMPEG_PATH` ve `FFPROBE_PATH` ortam değişkenleriyle verilebilir.

### Linux

Debian/Ubuntu tabanlı sistemlerde [dağıtımın resmi FFmpeg paketi](https://packages.ubuntu.com/ffmpeg) ile temel kurulum:

```bash
sudo apt update
sudo apt install ffmpeg
```

Dağıtım paketleri `libx264` içerse de `libvmaf` seçeneği dağıtıma/sürüme göre değişebilir. `ffmpeg -filters` ile doğrulayın; gerekiyorsa `libvmaf` destekli bir paket veya `--enable-libvmaf` ile derlenmiş FFmpeg kullanın.

## Çalıştırma

Harici npm bağımlılığı yoktur:

```bash
npm start
```

Ardından <http://127.0.0.1:4317> adresini açın. Portu değiştirmek için örneğin `PORT=8080 npm start` kullanın.

Testler:

```bash
npm test
```

FFmpeg, ffprobe ve libx264 mevcutsa test paketi sesli ve sessiz sentetik videolar üretir; hem tek süreçli hem iki worker'lı gerçek sıkıştırma yapar. Sonuçlar ffprobe ile yeniden açılarak H.264/AAC, MP4, FPS, çözünürlük, ses varlığı ve süre toleransı doğrulanır. Araçlar yoksa yalnız uçtan uca testler atlanır; unit testler çalışır.

Gerçek bir kaynakta geliştirme benchmark'ı:

```bash
npm run benchmark -- --input /tam/yol/video.webm --sample-seconds 120
```

Bu komut aynı kaynak bölümünde decode-only, decode+filtre, farklı x264 thread sayıları ve 1/2/4 worker encode seçeneklerini karşılaştırır. Tam dosyayı ölçmek için `--full`, kaliteyi karşılaştırmaya dahil etmek için `--quality sample` veya `--quality full` kullanılabilir. Çıktıda duvar saati süresi, FFmpeg speed değeri, yaklaşık CPU kullanımı, frame sayısı, çıktı boyutu/bitrate'i ve tek süreç bazına göre hızlanma gösterilir. Benchmark geçici çıktıları tamamlandığında siler.

### Ölçülmüş örnek

Apple M1 Pro / 8 mantıksal CPU üzerinde, 64:21 uzunluğundaki 2560×1440 60 FPS 10-bit VP9 kaynağın aynı 120 saniyelik gerçek bölümü 1280×720 25 FPS, CRF 23, ultrafast ve kalite analizi kapalıyken ölçüldü:

- Decode-only: 27,67 sn / 4,35× / yaklaşık %327 CPU.
- Decode + filtre: 25,32 sn / 4,76× / yaklaşık %342 CPU.
- Tek süreç, otomatik thread: 24,71 sn / 4,86× / 117,39 MiB.
- 2 worker × 4 thread: 22,87 sn / 5,25× / 117,42 MiB; tek sürece göre %7,44 daha kısa.
- 4 worker × 2 thread: 21,73 sn / 5,52× / 117,41 MiB; tek sürece göre %12,06 daha kısa.

Ayrıca 64:21'lik dosyanın tamamının decode-only ölçümü 14:41,98 (4,38×) sürdü. Önceki tam tek-süreç encode 15:24 olduğundan, bu kaynakta ana darboğazın x264 değil VP9 decode/filter hattı olduğu görülüyor. Yüzdeler bu makine ve içerik içindir; başka codec, disk veya CPU'da benchmark yeniden çalıştırılmalıdır.

## Sıkıştırma profili

Uygulama FFmpeg'i shell komutu yerine argument dizisiyle başlatır. Temel profil:

```text
-map 0:v:0 -map 0:a:0? -map_metadata -1
-threads 0 -i INPUT
-c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p -threads 0
-c:a aac -b:a 96k -ac 2 -movflags +faststart
-progress pipe:1 -nostats
```

- Kaynak seçilen çözünürlükten büyükse en-boy oranı korunarak 1080p veya 720p kutusuna sığdırılır. Video büyütülmez ve boyutlar çift sayı yapılır. Hız odaklı `fast_bilinear` ölçekleyici kullanılır.
- FPS filtresi yalnız kaynak FPS'i seçilen 30/25 sınırının üzerindeyse eklenir.
- `0:a:0?` opsiyonel ses eşlemesi sayesinde sessiz videolar hata vermez.
- Metadata kaldırılır, çıktı her zaman MP4 olur ve web/yerel oynatma başlangıcı için `+faststart` kullanılır.

### Tek süreç ve paralel encode

Arayüzde `Akıllı otomatik`, `Tek süreç`, `2 worker`, `3 worker` ve `4 worker` seçenekleri vardır. Tek süreç modu önceki hattı korur. Paralel mod kaynak dosyayı fiziksel olarak bölmeden aynı dosyanın FPS frame-grid'ine hizalanmış zaman aralıklarını eşzamanlı FFmpeg süreçlerine verir:

- Her worker aynı libx264, CRF, preset, pixel format, FPS ve çözünürlük ayarlarını kullanır.
- Toplam CPU'nun aşırı paylaşılmaması için threadler worker'lar arasında dengeli dağıtılır; örneğin 8 CPU'da üç worker `3+3+2`, dört worker `2+2+2+2` thread alır. Her worker'a `-threads 0` verilmez.
- Deterministik `chunk_000.mp4` adları yalnız işin UUID geçici dizinindedir ve public olarak sunulmaz.
- Video parçaları concat demuxer ile `-c copy` kullanılarak, ikinci bir video encode yapılmadan birleştirilir.
- Ses bir kez, kesintisiz tam akış olarak 48 kHz stereo AAC'e çevrilir ve son videoya stream-copy ile mux edilir. Böylece parça sınırlarında ses boşluğu/örtüşmesi oluşmaz; sessiz kaynağa yapay ses eklenmez.
- Birleştirme sonrası ffprobe codec, çözünürlük, FPS, süre ve ses varlığını doğrular. Doğrulama başarısızsa çıktı indirilebilir hale gelmez.
- İptal bütün aktif worker'ları sonlandırır; kısmi parçalar ve çıktı temizlenir. İş düzeyinde eşzamanlılık yine birdir, yani sıradaki ikinci kullanıcı işi worker'larla yarışmaz.

Akıllı otomatik plan 120 saniyeden kısa videolarda süreç/concat maliyetini önlemek için tek sürece döner. Daha uzun kaynaklarda CPU sayısı, süre, dosya boyutu ve çözünürlük × FPS decode yükünü birlikte puanlayarak 1–4 worker seçer. Minimum chunk süresi ve `MAX_PARALLEL_WORKERS` sınırı çok fazla küçük süreç açılmasını engeller. Seçim nedeni sonuç ekranında gösterilir. Paralel mod her içerikte mutlaka hızlı değildir; özellikle depolama bant genişliği veya decoder zaten doygunsa `Tek süreç` güvenli geri dönüş seçeneğidir.

### CRF ve preset

CRF, x264 kalite/boyut dengesini kontrol eder. Daha düşük CRF daha yüksek kalite ve genellikle daha büyük çıktı; daha yüksek CRF daha küçük dosya ve daha fazla kayıp demektir. 18–30 aralığı sunulur, varsayılan 23'tür.

Preset, encoder'ın sıkıştırma verimliliği için ne kadar CPU zamanı harcadığını belirler. Yavaş preset aynı CRF'te genellikle daha küçük çıktı üretir; hızlı preset daha kısa sürede tamamlanır. Varsayılan `ultrafast`, CPU-only kullanımda işlem süresini önceliklendirir; aynı CRF'te daha büyük çıktı üretebilir.

## Kalite ölçümü

Öncelikli metrik **Uçtan uca VMAF**'tır. Kaynak en fazla 1080p değerlendirme çözünürlüğüne indirilir; sıkıştırılmış görüntü aynı değerlendirme çözünürlüğüne geri ölçeklenir. Böylece çözünürlük kaybı skora dahil edilir. İki akış aynı FPS, zaman tabanı, başlangıç PTS'i, çözünürlük ve pixel formatına hizalanır.

- Hızlı örnekleme, videonun yaklaşık %10, %50 ve %90 noktalarında üç adet 10 saniyelik bölüm kullanır. 30 saniyeden kısa videolarda video üç çakışmayan bölüme ayrılır.
- Tam video modu bütün videoyu ölçer.
- Ortalama VMAF ile frame skorlarının doğrusal interpolasyonla hesaplanan 5. yüzdelik değeri gösterilir. Minimum frame skoru ana metrik olarak kullanılmaz.
- VMAF JSON logundan okunur ve ölçüm süresi encode süresinden ayrı tutulur.
- `libvmaf` yoksa SSIM ve PSNR açıkça fallback olarak etiketlenir.

VMAF algısal kaliteyi tahmin eder fakat her kullanım durumunu temsil etmez. İnce yazı, altyazı, ekran kaydı, terminal metni ve keskin UI kenarları küçük geometrik değişimlerden etkilenebilir; ortalama VMAF yüksek olsa bile metin okunabilirliği belirgin biçimde düşebilir. Bu içeriklerde çıktıyı gerçek boyutta görsel olarak da kontrol edin.

## Büyük dosyalar ve yaşam döngüsü

- Varsayılan upload sınırı 8 GiB'dir; 4 GB kaynaklar desteklenir. `MAX_UPLOAD_BYTES` ile değiştirilebilir.
- Upload gövdesi stream ile UUID tabanlı özel geçici dizine yazılır; `FileReader`, multipart buffer veya tüm-dosya RAM kopyası yoktur.
- İşleme başlamadan önce disk alanı kontrol edilir. 4 GB kaynak için en az kaynak + olası çıktı + güvenlik payını hesaba katın; sıkıştırma ve kalite ölçümü CPU'ya göre uzun sürebilir.
- Aynı anda tek encode çalışır, diğer işler FIFO kuyruğunda bekler.
- İptalde child process önce `SIGTERM`, gerekirse `SIGKILL` ile kapatılır; başarısız/iptal iş dosyaları silinir.
- Tamamlanan çıktı varsayılan 6 saat, indirilen çıktı 30 dakika sonra otomatik temizlenir. `FINISHED_TTL_MS` ve `DOWNLOADED_TTL_MS` ile ayarlanabilir.
- Kaynak dosya kalite ölçümü bittiğinde silinir. Sunucu kapanırken kalan FFmpeg process'leri ve geçici iş dizinleri temizlenir.
- Çıktı statik/public bir dosya adıyla sunulmaz; indirme rotası UUID ve kriptografik rastgele token içerir.

## Yapılandırma

- `PORT`: Varsayılan `4317`.
- `FFMPEG_PATH` / `FFPROBE_PATH`: Varsayılan olarak PATH üzerindeki `ffmpeg` ve `ffprobe`.
- `MAX_UPLOAD_BYTES`: Varsayılan 8 GiB upload sınırı.
- `MIN_FREE_BYTES`: Varsayılan 512 MiB disk güvenlik payı.
- `FINISHED_TTL_MS`: Varsayılan 6 saat tamamlanan iş saklama süresi.
- `DOWNLOADED_TTL_MS`: Varsayılan 30 dakika indirilen iş saklama süresi.
- `UPLOAD_TTL_MS`: Varsayılan 2 saat tamamlanmamış upload saklama süresi.
- `MAX_PARALLEL_WORKERS`: Otomatik/elle seçilen worker sayısının üst sınırı; varsayılan ve mutlak üst sınır `4`.

Bu araç lokal bir laboratuvardır; production authentication, kullanıcı veritabanı veya LMS entegrasyonu içermez.
