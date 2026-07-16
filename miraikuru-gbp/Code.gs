/**
 * 未ら来る｜Googleビジネスプロフィール 投稿自動化
 * GAS + Claude API (+ Drive写真 / GPT画像フォールバック)
 * ============================================================
 * 依頼仕様（未ら来る：熊本市下通りの和食居酒屋 / 月額顧問）
 *   - 承認なし・全自動で投稿
 *   - 投稿文は Claude API 生成（約300文字・季節感あり・曜日連動）
 *   - Drive の店舗写真を優先、テーマに合う写真がなければ GPT 画像生成
 *   - 投稿頻度は POST_WEEKDAYS で指定（週2回=火曜・金曜の11時）
 * ============================================================
 * ▼ スクリプトプロパティ（プロジェクトの設定 > スクリプト プロパティ）
 *   CLAUDE_API_KEY   … Anthropic APIキー（必須）
 *   OPENAI_API_KEY   … OpenAI APIキー（画像フォールバック用・任意）
 *   （写真は GitHub 公開リポジトリに置き、下記 PHOTOS に ファイル名＋写っている料理 を列挙）
 *   ACCOUNT_ID       … GBPアカウントID（setup_listIds で取得）
 *   LOCATION_ID      … GBPロケーションID（setup_listIds で取得）
 *   LOG_SHEET_ID     … 投稿ログ用スプレッドシートID（任意）
 * ============================================================
 */

// ===== 基本設定 =====
// 投稿する曜日（週2回）。GASの WeekDay 名で指定する。
// 例: ['TUESDAY','FRIDAY'] = 毎週 火曜・金曜。曜日を増やせば回数も増える。
const POST_WEEKDAYS = ['TUESDAY', 'FRIDAY'];
const POST_HOUR     = 11;                // 投稿時刻（時）
const CLAUDE_MODEL  = 'claude-sonnet-5'; // 投稿文生成モデル
const TZ            = 'Asia/Tokyo';
const STORE_NAME    = '未ら来る';
const STORE_DESC    = '熊本市下通り（安政町）にある「遊家 未ら来る」。馬刺し・肥後赤牛・海鮮と地酒が自慢の和風居酒屋。落ち着ける大人の隠れ家で個室が充実し、宴会・コースにも対応。営業は夜17時〜翌1時。';
// 実在メニュー（ホットペッパー https://www.hotpepper.jp/strJ001018684/ 参照）。
// 投稿文・返信はこの範囲の料理名だけを使い、存在しない料理は創作しない。
const STORE_MENU    = '極上馬刺し（タテガミ）、いくらがこぼれた刺身盛り合わせ、阿蘇溶岩焼き、肥後赤牛カルビ、馬ユッケ、馬にぎり五貫、名物 赤牛カルビ丼、もつ鍋、きのこの天婦羅盛り合わせ、海藤花、銀杏の素揚げ、辛子蓮根、肥後阿蘇美豚、牛タン、セセリ、地鶏のコロ焼き、秋刀魚の塩焼き（季節の一例）。地酒・焼酎・日本酒・ワイン・カクテルが豊富。コースは飲み放題付き4000円〜。';

// 投稿に使う写真。f=ファイル名、s=その写真に写っている料理／テーマ（＝文章の主役）。
// 文章は s を主役にして書くので、写真と本文が必ず一致する。
// 写真を足すときは photos/ に置いてpush → ここに1行 { f, s } を追加。
// s が空文字 '' の写真は特定料理を断定せず、空間・お酒・宴会を主役にする。
// （ロゴ画像 S__66641922_0.jpg は投稿対象から除外）
const PHOTO_BASE = 'https://raw.githubusercontent.com/coniniofficialkanri-hash/THE-TO-YOU-/main/miraikuru-gbp/photos/';
const PHOTOS = [
  // 馬刺し・馬肉
  { f: 'S__66641930.jpg', s: '極上馬刺し（タテガミ）を含む、色鮮やかな馬刺しの盛り合わせ' },
  { f: 'S__66641937.jpg', s: '各部位を楽しめる馬刺しの盛り合わせ' },
  { f: 'S__66641939.jpg', s: '霜降りと赤身が美しい馬刺しの盛り合わせ' },
  { f: 'S__66641938.jpg', s: 'とろりとした卵黄をのせた馬肉のユッケ' },
  { f: 'S__66641949.jpg', s: 'ネタが肉厚な馬肉の握り（馬にぎり）' },
  { f: 'S__66641950.jpg', s: '熊本ならではの馬肉の一品（炙り・燻製系）' },
  // 肥後赤牛・牛
  { f: 'S__66641925.jpg', s: '阿蘇溶岩焼きで香ばしく焼き上げた肥後赤牛' },
  { f: 'S__66641940.jpg', s: 'じっくり炊いた牛すじ・肉の煮込み' },
  // 刺身・海鮮
  { f: 'S__66641924.jpg', s: 'いくらがこぼれるほど贅沢な枡盛りの逸品' },
  { f: 'S__66641936.jpg', s: '新鮮なネタが並ぶ海鮮の刺身盛り合わせ' },
  { f: 'S__66641942.jpg', s: '彩り豊かな海鮮の刺身盛り合わせ' },
  { f: 'S__66641959.jpg', s: 'マグロやサーモンなど豪華な刺身の盛り合わせ' },
  { f: 'S__66641943.jpg', s: 'つるりと涼やかな白魚' },
  { f: 'S__66641944.jpg', s: '旬の青魚を使った刺身の一皿' },
  { f: 'S__66641965.jpg', s: '金目鯛の姿造り（豪華な一尾の刺身）' },
  { f: 'S__66641931.jpg', s: 'ぷりっと濃厚な牡蠣' },
  { f: 'S__66641941.jpg', s: 'みずみずしい殻付きの牡蠣' },
  { f: 'S__66641946.jpg', s: '旬の甲殻類（海老・蟹）の贅沢な一皿' },
  // 焼き魚
  { f: 'S__66641926.jpg', s: '旬の川魚の塩焼き（鮎）' },
  { f: 'S__66641935.jpg', s: '脂ののった秋刀魚の塩焼き' },
  // 揚げ物
  { f: 'S__66641927.jpg', s: '海老や旬野菜の天ぷら盛り合わせ' },
  { f: 'S__66641932.jpg', s: 'ほっくりとした銀杏の素揚げ' },
  // 一品・季節野菜
  { f: 'S__66641928.jpg', s: '熊本名物の辛子蓮根' },
  { f: 'S__66641929.jpg', s: '旬の青唐辛子を使った箸休めの一品' },
  { f: 'S__66641933.jpg', s: '香り高い松茸（秋の味覚）' },
  { f: 'S__66641951.jpg', s: 'さっぱりとした蒸し鶏のサラダ仕立て' },
  { f: 'S__66641960.jpg', s: '春の山菜・旬野菜の盛り合わせ' },
  // 鍋
  { f: 'S__66641947.jpg', s: 'ぷりぷりのもつがたっぷりのもつ鍋' },
  { f: 'S__66641948.jpg', s: '旬の魚を使った魚しゃぶ・鍋' },
  // コース・宴会（コースの品目は断定しない。飲み放題付き・個室・宴会利用の魅力を主役に）
  { f: 'S__66641952.jpg', s: '豪華に料理が並ぶ宴会の席。コースの品目は断定せず、飲み放題付きコース(4000円〜)・個室での宴会利用の魅力を主役に' },
  { f: 'S__66641953.jpg', s: 'テーブルいっぱいに料理が並ぶ宴会の様子。コースの品目は断定せず、コース・宴会利用の魅力を主役に' },
  { f: 'S__66641954.jpg', s: '多彩な料理が並ぶ宴会・コースの席。コースの品目は断定せず、コース・宴会利用の魅力を主役に' },
  { f: 'S__66641955.jpg', s: '生ビールを片手に楽しむ宴会の席。コースの品目は断定せず、宴会・飲み放題の魅力を主役に' },
  { f: 'S__66641957.jpg', s: '品数豊かなコース料理の席。コースの品目は断定せず、コース利用の魅力を主役に' },
  { f: 'S__66641958.jpg', s: '落ち着いた雰囲気の宴会・コースの席。コースの品目は断定せず、コース利用の魅力を主役に' },
  // ドリンク（料理は断定せず、お酒の品揃え・乾杯を主役に）
  { f: 'S__66641961.jpg', s: '豊富に取り揃えた本格焼酎の数々。特定の料理は出さず、お酒の品揃えを主役に' },
  { f: 'S__66641962.jpg', s: '厳選した日本酒・地酒の数々。特定の料理は出さず、お酒の品揃えを主役に' },
  { f: 'S__66641963.jpg', s: '乾杯にぴったりのシャンパン・スパークリング。特定の料理は出さず、お祝い・乾杯を主役に' },
  { f: 'S__66641964.jpg', s: '料理に寄り添うワインの品揃え。特定の料理は出さず、お酒の品揃えを主役に' },
  // 店内・個室（料理は断定せず、空間・個室・大人の隠れ家を主役に）
  { f: 'S__66781189.jpg', s: '落ち着いたテーブル個室の空間。特定の料理は出さず、個室・空間の心地よさを主役に' },
  { f: 'S__66781191.jpg', s: 'テレビ付きのテーブル個室。特定の料理は出さず、個室・少人数利用を主役に' },
  { f: 'S__66781192.jpg', s: '掘りごたつの座敷個室。特定の料理は出さず、個室・宴会利用を主役に' },
  { f: 'S__66781193.jpg', s: '開放感のある店内（ロフト席のある空間）。特定の料理は出さず、店内の雰囲気を主役に' },
  { f: 'S__66781194.jpg', s: '木の温もりある店内のテーブル席。特定の料理は出さず、店内の雰囲気を主役に' },
];

// =====================================================================
// 1. 初回セットアップ：アカウントID・ロケーションID を取得
//    → 実行後、ログの数字を ACCOUNT_ID / LOCATION_ID に登録
// =====================================================================
function setup_listIds() {
  const token = ScriptApp.getOAuthToken();
  const h = { Authorization: 'Bearer ' + token };

  const accRes = UrlFetchApp.fetch(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    { headers: h, muteHttpExceptions: true });
  Logger.log('=== ACCOUNTS (' + accRes.getResponseCode() + ') ===');
  Logger.log(accRes.getContentText());

  const accounts = (JSON.parse(accRes.getContentText()).accounts) || [];
  accounts.forEach(function (a) {
    const locRes = UrlFetchApp.fetch(
      'https://mybusinessbusinessinformation.googleapis.com/v1/' + a.name +
        '/locations?readMask=name,title,storefrontAddress&pageSize=100',
      { headers: h, muteHttpExceptions: true });
    Logger.log('=== LOCATIONS for ' + a.name + ' (' + locRes.getResponseCode() + ') ===');
    Logger.log(locRes.getContentText());
  });
  Logger.log('▶ accounts/XXXX の XXXX を ACCOUNT_ID、locations/YYYY の YYYY を LOCATION_ID に登録してください。');
}

// =====================================================================
// 2. メイン：投稿を1件 生成 → GBPへ投稿
// =====================================================================
function autoPost() {
  const props = PropertiesService.getScriptProperties();
  const accountId  = props.getProperty('ACCOUNT_ID');
  const locationId = props.getProperty('LOCATION_ID');
  if (!accountId || !locationId) {
    throw new Error('ACCOUNT_ID / LOCATION_ID が未設定です。setup_listIds を実行してください。');
  }

  const theme    = buildTheme_();                              // 季節・曜日からテーマ決定
  const photo    = pickPhoto_();                               // 写真を先に選ぶ（文章と一致させる）
  const text     = generatePostText_(theme, photo ? photo.s : ''); // 写真の料理を主役に本文生成
  const mediaUrl = photo ? (PHOTO_BASE + photo.f) : resolveGptImage_(theme);

  const post = { languageCode: 'ja', summary: text, topicType: 'STANDARD' };
  if (mediaUrl) post.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];

  const url = 'https://mybusiness.googleapis.com/v4/accounts/' + accountId +
              '/locations/' + locationId + '/localPosts';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify(post),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  Logger.log('GBP応答: ' + code + ' ' + res.getContentText());
  logToSheet_(theme, text, mediaUrl, code, res.getContentText());
  if (code >= 300) throw new Error('投稿失敗(' + code + '): ' + res.getContentText());
}

// =====================================================================
// 3. テスト用：投稿はせず、生成した本文・画像URLをログ出力
//    （GBP API 審査待ちの間の動作確認に）
// =====================================================================
function test_generateOnly() {
  const theme = buildTheme_();
  const photo = pickPhoto_();
  const text  = generatePostText_(theme, photo ? photo.s : '');
  Logger.log('■ テーマ: ' + JSON.stringify(theme));
  Logger.log('■ 写真の主役: ' + (photo ? photo.s : '(なし)'));
  Logger.log('■ 本文(' + text.length + '字):\n' + text);
  Logger.log('■ 画像URL: ' + (photo ? PHOTO_BASE + photo.f : '(なし)'));
}

// ===== 季節・曜日テーマ =====
function buildTheme_() {
  const now   = new Date();
  const month = Number(Utilities.formatDate(now, TZ, 'M'));
  const dow   = Number(Utilities.formatDate(now, TZ, 'u')); // 1=月 … 7=日
  const season = (month === 12 || month <= 2) ? '冬'
               : (month <= 5) ? '春'
               : (month <= 8) ? '夏' : '秋';
  const dowName = ['', '月', '火', '水', '木', '金', '土', '日'][dow];
  return { month: month, season: season, dow: dowName, weekend: (dow >= 5) };
}

// ===== Claude で投稿文生成（subject = 添付写真に写っている料理／テーマ）=====
function generatePostText_(theme, subject) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY が未設定です。');

  const system = STORE_NAME + 'は' + STORE_DESC +
    'です。Googleビジネスプロフィールの「最新情報」投稿文を書くプロのSNS運用担当です。';
  const rules = [
    '次の条件で投稿文を1本だけ書いてください。',
    '・【最重要】文字数は必ず300〜330字にする。280字未満は不可。短い場合は情景や料理の描写を丁寧にふくらませて必ず300字以上にする。',
    '・' + theme.season + 'の季節感を必ず盛り込む。',
    '・今日は' + theme.dow + '曜日。' +
      (theme.weekend ? '週末なのでご宴会・コース（飲み放題付き）・個室のご予約を促す。' : '仕事帰りの一杯や少人数での利用に寄せる。'),
    (subject
      ? '・この投稿には写真が付き、写真の内容は「' + subject + '」。必ずこの内容を主役にして具体的に描写する。写真と違う料理を主役にしてはいけない。'
      : '・料理は当店の実在メニューから1〜2品だけ選んで具体的に描写する（存在しない料理は創作しない）。'),
    '・使ってよいのは当店の実在メニューの範囲のみ: ' + STORE_MENU,
    '・上記メニューは基本「単品」。コースの具体的な品目は非公開なので断定しない。コースに触れるときは「飲み放題付き4000円〜・個室で宴会向け」程度に留め、特定の料理を「コースに含まれる／コースで味わえる」とは書かない。',
    '・熊本らしい馬刺し・肥後赤牛・海鮮や、豊富な地酒に触れてよい。',
    '・営業は夜（17時〜翌1時）。朝・昼・ランチの描写はしない。',
    '・「落ち着ける大人の隠れ家」らしい、上品で落ち着いたトーン。',
    '・絵文字は0〜2個まで。過度に宣伝くさくしない。',
    '・最後に自然な来店の一言。電話番号やURLは書かない。',
    '・見出しや箇条書きは使わず、本文だけを返す。'
  ].join('\n');

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 800, system: system,
      messages: [{ role: 'user', content: rules }]
    }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.content || !body.content[0]) {
    throw new Error('Claude応答異常: ' + res.getContentText());
  }
  return body.content[0].text.trim();
}

// ===== 写真選択：PHOTOS からランダムに1枚（本文はその写真の s を主役にする）=====
function pickPhoto_() {
  if (typeof PHOTOS === 'undefined' || !PHOTOS.length) return null;
  return PHOTOS[Math.floor(Math.random() * PHOTOS.length)];
}

// 写真が無いときのGPT画像フォールバック（OPENAI_API_KEY がある場合のみ）
function resolveGptImage_(theme) {
  const openaiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (openaiKey) {
    try { return generateGptImage_(theme, openaiKey, null); }
    catch (e) { Logger.log('GPT画像生成失敗: ' + e); }
  }
  return null; // 画像なしテキスト投稿
}

function generateGptImage_(theme, apiKey, folderId) {
  const prompt = '熊本の和風居酒屋で提供される' + theme.season +
    'の料理写真。馬刺し・肥後赤牛・海鮮・刺身盛り合わせ・地酒など和の料理。' +
    '木のカウンターや落ち着いた個室、温かい隠れ家的な雰囲気、湯気。' +
    'プロの盛り付け、写実的、高画質。文字・ロゴは入れない。';
  const res = UrlFetchApp.fetch('https://api.openai.com/v1/images/generations', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify({ model: 'gpt-image-1', prompt: prompt, size: '1024x1024', n: 1 }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.data || !body.data[0] || !body.data[0].b64_json) {
    throw new Error('OpenAI画像応答異常: ' + res.getContentText());
  }
  const blob = Utilities.newBlob(
    Utilities.base64Decode(body.data[0].b64_json), 'image/png', 'gbp_' + Date.now() + '.png');
  const file = folderId ? DriveApp.getFolderById(folderId).createFile(blob) : DriveApp.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

// ===== 投稿ログ（任意：LOG_SHEET_ID があれば追記） =====
function logToSheet_(theme, text, mediaUrl, code, resBody) {
  const id = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID');
  if (!id) return;
  try {
    const sh = SpreadsheetApp.openById(id).getSheets()[0];
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      theme.season, theme.dow + '曜', text.length + '字',
      mediaUrl ? 'あり' : 'なし', code, text, resBody
    ]);
  } catch (e) { Logger.log('ログ記録失敗: ' + e); }
}

// =====================================================================
// 4. 口コミ返信自動化：未返信レビューに Claude 生成の返信を投稿
// =====================================================================
const REPLY_STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function autoReplyReviews() {
  const props = PropertiesService.getScriptProperties();
  const accountId  = props.getProperty('ACCOUNT_ID');
  const locationId = props.getProperty('LOCATION_ID');
  if (!accountId || !locationId) {
    throw new Error('ACCOUNT_ID / LOCATION_ID が未設定です。setup_listIds を実行してください。');
  }

  const base = 'https://mybusiness.googleapis.com/v4/accounts/' + accountId +
               '/locations/' + locationId + '/reviews';
  const token = ScriptApp.getOAuthToken();
  let pageToken = '';
  let replied = 0;

  do {
    const url = base + '?pageSize=50&orderBy=updateTime desc' +
                (pageToken ? '&pageToken=' + pageToken : '');
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) {
      throw new Error('レビュー取得失敗(' + res.getResponseCode() + '): ' + res.getContentText());
    }
    const body = JSON.parse(res.getContentText());
    const reviews = body.reviews || [];

    reviews.forEach(function (rv) {
      if (rv.reviewReply) return;                 // 既に返信済みはスキップ
      const reply = generateReviewReply_(rv);
      const putRes = UrlFetchApp.fetch(
        'https://mybusiness.googleapis.com/v4/' + rv.name + '/reply', {
          method: 'put',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ comment: reply }),
          muteHttpExceptions: true
        });
      const code = putRes.getResponseCode();
      Logger.log('返信(' + code + '): ' + (rv.reviewer && rv.reviewer.displayName) +
                 ' [' + rv.starRating + '] → ' + reply.slice(0, 40) + '…');
      logReplyToSheet_(rv, reply, code, putRes.getContentText());
      if (code < 300) replied++;
      Utilities.sleep(1200);                      // レート制御
    });

    pageToken = body.nextPageToken || '';
  } while (pageToken);

  Logger.log('口コミ返信 完了：' + replied + '件に返信しました。');
}

// レビュー内容・星評価から返信文を生成
function generateReviewReply_(rv) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY が未設定です。');

  const star = REPLY_STAR[rv.starRating] || 0;
  const name = (rv.reviewer && rv.reviewer.displayName) ? rv.reviewer.displayName : 'お客様';
  const comment = rv.comment ? rv.comment : '（コメントなし・星評価のみ）';

  const tone = star >= 4
    ? '感謝を中心に、また来たくなる温かい返信。'
    : star === 3
      ? '感謝しつつ、改善の姿勢と再来店を促す誠実な返信。'
      : '真摯に謝罪し、改善する姿勢を示す。言い訳や反論はしない。丁寧で低姿勢に。';

  const system = STORE_NAME + 'は' + STORE_DESC +
    'です。あなたは店主として、Googleの口コミに返信します。';
  const rules = [
    'お客様「' + name + '」からの★' + star + 'の口コミに返信してください。',
    '口コミ本文：「' + comment + '」',
    '',
    '条件：',
    '・' + tone,
    '・120〜180文字程度。',
    '・冒頭でお客様に呼びかけ、来店・投稿へのお礼を述べる。',
    '・和食居酒屋らしい温かみのある言葉づかい。',
    '・定型文っぽさを避け、口コミ内容に具体的に触れる。',
    '・絵文字は使わないか1個まで。返信本文だけを返す。'
  ].join('\n');

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 500, system: system,
      messages: [{ role: 'user', content: rules }]
    }),
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText());
  if (!body.content || !body.content[0]) {
    throw new Error('Claude応答異常: ' + res.getContentText());
  }
  return body.content[0].text.trim();
}

function logReplyToSheet_(rv, reply, code, resBody) {
  const id = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID');
  if (!id) return;
  try {
    const ss = SpreadsheetApp.openById(id);
    let sh = ss.getSheetByName('口コミ返信');
    if (!sh) sh = ss.insertSheet('口コミ返信');
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
      (rv.reviewer && rv.reviewer.displayName) || '', rv.starRating,
      rv.comment || '', reply, code, resBody
    ]);
  } catch (e) { Logger.log('返信ログ記録失敗: ' + e); }
}

// 返信のテスト（実際には返信せず、生成文だけログ出力）
function test_replyGenerateOnly() {
  const props = PropertiesService.getScriptProperties();
  const url = 'https://mybusiness.googleapis.com/v4/accounts/' + props.getProperty('ACCOUNT_ID') +
              '/locations/' + props.getProperty('LOCATION_ID') + '/reviews?pageSize=5&orderBy=updateTime desc';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  const reviews = (JSON.parse(res.getContentText()).reviews) || [];
  if (!reviews.length) { Logger.log('レビューが取得できませんでした: ' + res.getContentText()); return; }
  reviews.forEach(function (rv) {
    Logger.log('★' + rv.starRating + ' ' + ((rv.reviewer && rv.reviewer.displayName) || '') +
               (rv.reviewReply ? '（返信済）' : '（未返信）') + '\n口コミ: ' + (rv.comment || '(なし)') +
               '\n→ 生成返信: ' + generateReviewReply_(rv) + '\n---');
  });
}

// =====================================================================
// 5. トリガー設定：INTERVAL_DAYS 日に1回・POST_HOUR 時に autoPost
// =====================================================================
function setup_trigger() {
  // 既存の autoPost トリガーを一旦すべて削除（重複防止）
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoPost') ScriptApp.deleteTrigger(t);
  });
  // POST_WEEKDAYS の各曜日に1本ずつ作成 → 「毎週その曜日の POST_HOUR 時」に実行
  POST_WEEKDAYS.forEach(function (wd) {
    ScriptApp.newTrigger('autoPost')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay[wd])
      .atHour(POST_HOUR)
      .inTimezone(TZ)
      .create();
  });
  Logger.log('トリガー設定完了：毎週 ' + POST_WEEKDAYS.join('・') +
             ' の ' + POST_HOUR + '時（' + TZ + '）に投稿。合計 ' +
             POST_WEEKDAYS.length + ' 本のトリガーを作成しました。');
}

// 口コミ返信を毎日1回チェック（未返信があれば返信）
function setup_replyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'autoReplyReviews') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoReplyReviews')
    .timeBased().everyDays(1).atHour(10).inTimezone(TZ).create();
  Logger.log('口コミ返信トリガー設定完了：毎日10時に未返信チェック');
}

// 投稿・返信の全トリガーを削除
function setup_deleteTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'autoPost' || fn === 'autoReplyReviews') ScriptApp.deleteTrigger(t);
  });
  Logger.log('autoPost / autoReplyReviews のトリガーを全削除しました。');
}
