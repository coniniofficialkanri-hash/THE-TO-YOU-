/**
 * GPT同士会話バズ動画システム 自動化GAS一式
 *
 * 機能：
 *  1. weeklyGenerateTopics : 週1回、Claude APIでネタ7本＋着火セリフ＋キャプションを「ネタ帳」シートに自動生成
 *  2. dailyPublishReel     : 毎日、投稿キューの「予約」行をInstagram Graph APIでリール自動投稿
 *  3. dailyFetchInsights   : 毎日、投稿済みリールの再生数・保存数等を「インサイト」シートに記録
 *
 * ── 初期セットアップ ──────────────────────────────
 * 1. スプレッドシートを新規作成し、拡張機能 > Apps Script にこのコードを貼る
 * 2. setup() を1回実行（シート3枚とヘッダーを自動作成）
 * 3. プロジェクト設定 > スクリプトプロパティに以下を登録：
 *    - ANTHROPIC_API_KEY : Claude APIキー
 *    - IG_USER_ID        : InstagramビジネスアカウントのID（Graph APIのig-user-id）
 *    - META_ACCESS_TOKEN : Meta長期アクセストークン（instagram_content_publish権限付き）
 * 4. トリガー設定：
 *    - weeklyGenerateTopics : 週ベース・月曜 6〜7時
 *    - dailyPublishReel     : 日付ベース・18〜19時（投稿は19時想定）
 *    - dailyFetchInsights   : 日付ベース・深夜1〜2時
 *
 * ── Instagram側の前提 ─────────────────────────────
 * ・Instagramをプロアカウント化し、Facebookページと連携
 * ・Meta for Developersでアプリ作成 → instagram_basic / instagram_content_publish /
 *   pages_read_engagement を許可した長期トークンを取得
 * ・動画はGoogle Driveに置き「リンクを知っている全員が閲覧可」にする
 *   （100MB超や回線状況でDrive直リンクが弾かれる場合はVercel等の静的ホスティングに置く）
 */

const GRAPH_VER = 'v21.0';
const POST_HOUR = 19; // 自動投稿する時刻（トリガーはこれより前に設定）

const MODES = [
  '1:大喧嘩(毒舌関西弁×超ポジティブ)',
  '2:異世界ビジネス(堅物敬語×平成ギャル)',
  '3:ガチ討論(肯定派×否定派)',
  '4:恋愛ドラマ(口説き×塩対応)',
  '5:世代間ギャップ(じいちゃん×Z世代)',
  '6:中二病×現実主義',
  '7:メタ回(お前もAIか)',
];

function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

/** 初回だけ実行：シートとヘッダーを作成 */
function setup() {
  const defs = {
    'ネタ帳': ['生成日', 'モード', 'お題', '最初のひと言', 'キャプション', '使用済み'],
    '投稿キュー': ['投稿日', '動画DriveリンクorURL', 'キャプション', 'モード', 'ステータス', 'メディアID', '投稿日時'],
    'インサイト': ['取得日', 'メディアID', 'モード', '投稿日', '再生数', 'いいね', 'コメント', '保存', 'シェア', 'リーチ'],
  };
  Object.keys(defs).forEach((name) => {
    let sh = ss_().getSheetByName(name);
    if (!sh) sh = ss_().insertSheet(name);
    if (sh.getLastRow() === 0) sh.appendRow(defs[name]);
  });
}

/* ============================================================
 * 1. ネタ自動生成（週次）
 * ============================================================ */
function weeklyGenerateTopics() {
  const apiKey = props_().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) { Logger.log('ANTHROPIC_API_KEY 未設定のためスキップしました'); return; }

  const prompt = [
    'あなたはSNSバズ動画の放送作家です。',
    '「ChatGPTの音声モードを積んだスマホ2台を会話させる」ショート動画のネタを7本作ってください。',
    '各ネタは以下のモードから1つずつ選び（7本で7モード全てを1回ずつ使う）、JSON配列のみで出力してください。',
    'モード一覧: ' + MODES.join(' / '),
    '',
    '各要素のキー:',
    '- mode: モード名（上の一覧の文字列そのまま）',
    '- topic: お題（15字以内）',
    '- seed: 撮影者がスマホに言う最初のひと言（自然な話し言葉・30字以内）',
    '- caption: インスタ用キャプション（絵文字入り・保存とコメントを促す・ハッシュタグ #ChatGPT #AI #AI同士の会話 を含める）',
    '',
    '条件: 日本のSNSで共感されやすい日常ネタ。討論モードのお題はコメント欄が割れるものにする。',
    'JSON以外の文字は一切出力しないこと。',
  ].join('\n');

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude APIエラー: ' + res.getContentText());

  const text = JSON.parse(res.getContentText()).content[0].text;
  const jsonStr = text.substring(text.indexOf('['), text.lastIndexOf(']') + 1);
  const topics = JSON.parse(jsonStr);

  const sh = ss_().getSheetByName('ネタ帳');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  topics.forEach((t) => sh.appendRow([today, t.mode, t.topic, t.seed, t.caption, '']));
  Logger.log(topics.length + '本のネタを生成しました');
}

/* ============================================================
 * 2. リール自動投稿（日次）
 *    「投稿キュー」で 投稿日<=今日 かつ ステータス=予約 の行を投稿
 * ============================================================ */
function dailyPublishReel() {
  if (!props_().getProperty('META_ACCESS_TOKEN') || !props_().getProperty('IG_USER_ID')) { Logger.log('Meta連携が未設定のためスキップしました'); return; }

  const sh = ss_().getSheetByName('投稿キュー');
  const rows = sh.getDataRange().getValues();
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  for (let i = 1; i < rows.length; i++) {
    const [postDate, videoUrl, caption, , status] = rows[i];
    if (status !== '予約' || !videoUrl) continue;
    if (postDate && new Date(postDate) > today) continue;

    try {
      const mediaId = publishReel_(toPublicVideoUrl_(String(videoUrl)), String(caption));
      sh.getRange(i + 1, 5).setValue('投稿済み');
      sh.getRange(i + 1, 6).setValue(mediaId);
      sh.getRange(i + 1, 7).setValue(new Date());
      Logger.log('投稿完了: ' + mediaId);
    } catch (e) {
      sh.getRange(i + 1, 5).setValue('エラー: ' + e.message);
    }
    break; // 1日1本
  }
}

/** DriveリンクをGraph APIが取得できる直リンクに変換 */
function toPublicVideoUrl_(url) {
  const m = url.match(/\/d\/([\w-]+)/) || url.match(/[?&]id=([\w-]+)/);
  if (m) return 'https://drive.google.com/uc?export=download&id=' + m[1];
  return url; // Drive以外（Vercel等の直URL）はそのまま
}

function publishReel_(videoUrl, caption) {
  const igId = props_().getProperty('IG_USER_ID');
  const token = props_().getProperty('META_ACCESS_TOKEN');
  const base = 'https://graph.facebook.com/' + GRAPH_VER + '/';

  // 1) コンテナ作成
  const create = JSON.parse(UrlFetchApp.fetch(base + igId + '/media', {
    method: 'post',
    payload: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption,
      share_to_feed: 'true',
      access_token: token,
    },
    muteHttpExceptions: true,
  }).getContentText());
  if (!create.id) throw new Error('コンテナ作成失敗: ' + JSON.stringify(create));

  // 2) 処理完了までポーリング（最大5分）
  for (let i = 0; i < 30; i++) {
    Utilities.sleep(10000);
    const st = JSON.parse(UrlFetchApp.fetch(
      base + create.id + '?fields=status_code&access_token=' + token,
      { muteHttpExceptions: true }
    ).getContentText());
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR') throw new Error('動画処理エラー（Drive直リンクが弾かれた可能性。別ホスティングを検討）');
  }

  // 3) 公開
  const pub = JSON.parse(UrlFetchApp.fetch(base + igId + '/media_publish', {
    method: 'post',
    payload: { creation_id: create.id, access_token: token },
    muteHttpExceptions: true,
  }).getContentText());
  if (!pub.id) throw new Error('公開失敗: ' + JSON.stringify(pub));
  return pub.id;
}

/* ============================================================
 * 3. インサイト自動取得（日次）
 * ============================================================ */
function dailyFetchInsights() {
  const token = props_().getProperty('META_ACCESS_TOKEN');
  if (!token) { Logger.log('META_ACCESS_TOKEN 未設定のためスキップしました'); return; }

  const base = 'https://graph.facebook.com/' + GRAPH_VER + '/';
  const queue = ss_().getSheetByName('投稿キュー').getDataRange().getValues();
  const sh = ss_().getSheetByName('インサイト');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  for (let i = 1; i < queue.length; i++) {
    const [postDate, , , mode, status, mediaId] = queue[i];
    if (status !== '投稿済み' || !mediaId) continue;

    const res = JSON.parse(UrlFetchApp.fetch(
      base + mediaId + '/insights?metric=views,likes,comments,saved,shares,reach&access_token=' + token,
      { muteHttpExceptions: true }
    ).getContentText());
    if (!res.data) continue;

    const v = {};
    res.data.forEach((d) => { v[d.name] = d.values && d.values[0] ? d.values[0].value : 0; });
    sh.appendRow([today, mediaId, mode, postDate,
      v.views || 0, v.likes || 0, v.comments || 0, v.saved || 0, v.shares || 0, v.reach || 0]);
  }
}

/* ============================================================
 * 4. トリガー一括設定（1回だけ実行すればOK）
 *    既存トリガーを消してから3本を貼り直すので、何度実行しても重複しない
 * ============================================================ */
function createTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('weeklyGenerateTopics').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  ScriptApp.newTrigger('dailyPublishReel').timeBased()
    .everyDays(1).atHour(18).create();
  ScriptApp.newTrigger('dailyFetchInsights').timeBased()
    .everyDays(1).atHour(1).create();

  Logger.log('トリガー3本を設定しました（タイムゾーン: ' + Session.getScriptTimeZone() + '）');
  Logger.log('月曜6時台=ネタ生成 / 毎日18時台=リール投稿 / 毎日1時台=インサイト取得');
}

/* ============================================================
 * 5. ネタ帳の初期投入（APIキーが無くてもすぐ撮影を始められるように）
 *    7モード×3本＝21本。1回だけ実行すればOK
 * ============================================================ */
const SEED_TOPICS = [
  ['1:大喧嘩(毒舌関西弁×超ポジティブ)', '仕事で怒られた', '今日仕事でめっちゃ怒られてん'],
  ['1:大喧嘩(毒舌関西弁×超ポジティブ)', 'ダイエット挫折', 'ダイエット3日で挫折したわ'],
  ['1:大喧嘩(毒舌関西弁×超ポジティブ)', 'スマホが割れた', 'スマホの画面バキバキに割れた'],
  ['2:異世界ビジネス(堅物敬語×平成ギャル)', '飲み会の擦り合わせ', '来週の飲み会の件、すり合わせさせてください'],
  ['2:異世界ビジネス(堅物敬語×平成ギャル)', '合コンの振り返り', '先日の合コンのフィードバックをいただけますか'],
  ['2:異世界ビジネス(堅物敬語×平成ギャル)', '推し活の予算申請', '推し活の予算申請をしたいのですが'],
  ['3:ガチ討論(肯定派×否定派)', 'きのこvsたけのこ', 'お題：きのこの山とたけのこの里、どっちが上か'],
  ['3:ガチ討論(肯定派×否定派)', 'デートの割り勘', 'お題：デートの割り勘はアリかナシか'],
  ['3:ガチ討論(肯定派×否定派)', '目玉焼きは何をかける', 'お題：目玉焼きは醤油かソースか'],
  ['4:恋愛ドラマ(口説き×塩対応)', '運命を感じた', '初めまして、運命を感じたので声をかけました'],
  ['4:恋愛ドラマ(口説き×塩対応)', '付き合うメリット', '僕と付き合うメリットをプレゼンさせてください'],
  ['4:恋愛ドラマ(口説き×塩対応)', '前世で会った', '前世で会った気がするんだ'],
  ['5:世代間ギャップ(じいちゃん×Z世代)', 'サブスクとは', 'じいちゃん、サブスクって知ってる？'],
  ['5:世代間ギャップ(じいちゃん×Z世代)', 'マッチングアプリ', 'じいちゃん、マッチングアプリって知ってる？'],
  ['5:世代間ギャップ(じいちゃん×Z世代)', 'AIとは', 'じいちゃん、AIって知ってる？'],
  ['6:中二病×現実主義', 'コンビニに行く', '今日、コンビニに行こうと思う'],
  ['6:中二病×現実主義', 'Wi-Fiが繋がらない', 'Wi-Fiが繋がらない'],
  ['6:中二病×現実主義', 'レポートの締切', 'レポートの締切が明日なんだ'],
  ['7:メタ回(お前もAIか)', '天気の雑談', '最近、暑いよね'],
  ['7:メタ回(お前もAIか)', '休日の過ごし方', '休みの日って何してるの？'],
  ['7:メタ回(お前もAIか)', '生きる意味', '人間って何のために生きてるんだろうね'],
];

function seedTopics() {
  const sh = ss_().getSheetByName('ネタ帳');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  SEED_TOPICS.forEach(function(t) {
    const caption = 'AI同士に「' + t[1] + '」させてみた結果www\n\n'
      + 'スマホ2台のAIを会話させたら想像の上いった🤖🤖\n'
      + '続きが見たい人は保存推奨\n\n'
      + '次に会話させたい2人、コメントで募集中👇\n\n'
      + '#ChatGPT #AI #AI同士の会話 #検証 #おもしろ動画';
    sh.appendRow([today, t[0], t[1], t[2], caption, '']);
  });
  Logger.log(SEED_TOPICS.length + '本のネタを投入しました');
}

/* 投稿キューの「ステータス」列にプルダウンを設定（表記ゆれで投稿されない事故を防ぐ） */
function setupStatusDropdown() {
  const sh = ss_().getSheetByName('投稿キュー');
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['予約', '投稿済み', '保留'], true).setAllowInvalid(false).build();
  sh.getRange(2, 5, 500, 1).setDataValidation(rule);
  sh.setFrozenRows(1);
  ss_().getSheetByName('ネタ帳').setFrozenRows(1);
  ss_().getSheetByName('インサイト').setFrozenRows(1);
  Logger.log('ステータス列のプルダウンと見出し固定を設定しました');
}
