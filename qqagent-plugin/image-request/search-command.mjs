// 「我要 xxx 的图」这类**确定性搜图指令**的识别（给 QQ Agent 用）
//
// ── 为什么要有它 ───────────────────────────────────────────────────────────
// 平常搜图是模型调用 `pixiv_search` 工具：那一轮对话要烧掉一整个上下文（提示词 + 历史 +
// 工具定义）的 token，只为了认出一句「来张初音ミク的图」。
// 这里把**固定句式**做成确定性触发：核心在消息入库前问一句插件，命中就直接搜图下载，
// **完全不叫醒模型 —— 0 token**。没命中的句子照旧走模型（工具那条路一点没变）。
//
// 支持的句式（xxx = 关键词，可带「的」，末尾必须是「图/图片」）：
//   我要xxx的图 / 我要看xxx的图 / 我想看xxx的图 / 想看看xxx的图
//   来点xxx的图 / 来张xxx的图 / 来3张xxx的图 / 来几张xxx的图 / 多来几张xxx的图
//   有没有xxx的图 / 有xxx的图吗 / 求xxx的图 / 给我来点xxx的图 / 搜点xxx的图
//
// ── 刻意的"保守"设计（宁可漏，不可错）────────────────────────────────────
//   · **必须命中开头那个触发词**才算：「刚刚那张图」「这张图的链接」这种一律不算，
//     否则群里正常的聊天会被当成搜图指令（还会静默下载一堆乱七八糟的东西）；
//   · 末尾必须是「图/图片」，`我要这张图的出处` 不会命中；
//   · 长度上限（默认 40 字）：长句子里的"我要…的图"多半是真在说话，不是点图；
//   · 关键词里不允许出现「什么/哪张/这张/那张」这类指示词（`有没有什么好看的图`）；
//   · @ 了**别人**（不是机器人）时不认领：那多半是在跟别的群友说话。

/** 结尾词（长的先试，「的图片」不能被「图」先吃掉） */
const TAIL_WORDS = ['的图片', '的插画', '圖片', '的图', '图片', '图'];

/** 开头触发词。**长的必须排在前面**（下面会按长度重新排序），否则「我要看」会被「我要」截断 */
const LEAD_WORDS = [
  // 我要 / 我想
  '我真的很想看', '我想要看', '我想看看', '我要看看', '我超级想看', '我想要', '我要看', '我想看', '想看', '我要', '我想',
  // 来点 / 来张
  '多来几张', '再给我来', '给我来点', '给我来张', '给我来几张', '给我发点', '给我发张', '给我发', '给我来', '给我几张',
  '给我一张', '给我一个', '给我个', '给我点', '给我张', '给我',
  '来几张', '来一张', '来多点', '来点', '来张', '来个', '来几', '来一', '来',
  // 再来 / 再给（群里真的有人这么说）
  '再给我来几张', '再给我来点', '再给我来张', '再给我来', '再多来几张', '再多来一张', '再多来点', '再多来',
  '再来几张', '再来一张', '再来点', '再来个', '再给几张', '再给点', '再给', '再来',
  // 给 / 送 / 发（「给点蔚蓝档案的图」「送我几张…的图片」）
  '给我', '给几张', '给一个', '给一张', '给点', '给个', '给',
  '送我几张', '送我一张', '送我个', '送点', '送我', '送几张', '送',
  '发几张', '发一个', '发一张', '发点', '发个', '发',
  // 有没有 / 求 / 搜 / 找
  '有没有', '有木有', '有无', '有',
  '求求', '求', '搜一下', '搜点', '搜几张', '搜',
  '找一下', '找几张', '找找', '找点', '找'
];

const LEADS = [...new Set(LEAD_WORDS)].sort((a, b) => b.length - a.length);

/** 「来3张」「来三张」「来几张」里的数量
 *  2026-10-20：原来只认 1~2 位数字（最多 99），现在放到 3 位，配合"没有硬上限"。 */
const COUNT_RE = /^(?:(\d{1,3})|([一二两三四五六七八九十]))\s*(?:张|个|份|幅|副)/;
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 尾巴上的语气词与标点：「…的图吗？」「…的图，谢谢」 */
const NOISE_TAIL = /[\s,，、。.!！?？~～…]*?(?:吗|嘛|呢|呀|啊|吧|呗|哈|哦|噢|喔|谢谢|多谢|thanks|thx|3q|可以吗|行吗|好不好|可否)*[\s,，、。.!！?？~～…]*$/i;

/** 不该当关键词的指示词开头：命中说明这多半不是"点图"，而是在指某张图 */
const BAD_KEYWORD = /^(?:什么|啥|啥子|哪|哪张|哪张图|这张|那张|这|那|它|他|她|你|我|上面|下面|刚才|刚刚|这个|那个|几张|一张|点|张|些|个|的)/;

/**
 * 整句其实是别的意思（不是点图）。先排除，否则「发现这张图」会被拆成触发词「发」+ 关键词「现这张」。
 */
const NOT_A_REQUEST = [/^发现/, /^发觉/, /^觉得/, /^以为/, /^听说/, /^看这/, /^看那/];

/** 关键词里绝对不该出现的字符 */
const BAD_CHARS = /[?？!！。，,、;；:："'“”‘’()（）[\]【】<>《》\r\n\t]/;

function normalizeSpace(text) {
  return String(text ?? '')
    .replace(/[\u3000\u00a0]/g, ' ')     // 全角/不换行空格
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉开头的 @——优先用核心给的 atNames 原文（精确），否则退回保守的正则 */
function stripMentions(text, atNames = []) {
  let s = text;
  for (const raw of atNames) {
    const name = String(raw || '').trim();
    if (!name) continue;
    while (s.startsWith(name)) s = s.slice(name.length).trim();
  }
  // 兜底：@名字(QQ:123) / @名字 / @123456（只吃一个词，不吃后面的整句）
  s = s.replace(/^@(?:全体成员|[^\s@]{1,40}?\(QQ:\d+\)|[^\s@]{1,40})(?=\s|$)/, '').trim();
  // 行内残留的 @全体成员 也去掉
  return s.replace(/^@全体成员/, '').trim();
}

/** 去掉成对的引号与书名号：`「初音ミク」的图` → `初音ミク` */
function stripQuotes(text) {
  let s = String(text ?? '').trim();
  const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ['《', '》'], ["'", "'"]];
  let changed = true;
  while (changed && s.length > 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
      }
    }
  }
  return s;
}

/**
 * 剥掉"与…相关"这种外壳：「找与pid120514666相关的图片」→ `pid120514666`
 * （只剥 与/关于 和 相关/有关 —— 不剥「和/跟」，因为「和风」这种关键词真的存在）
 */
function stripAbout(keyword) {
  return String(keyword ?? '')
    .replace(/^(?:与|關於|关于)/, '')
    .replace(/(?:相关的内容|相关的|相关性|相关|有关的|有关)$/, '')
    .trim();
}

/** 「3张 / 三张 / 几张」→ { count, rest }；count=0 表示"没明说数量" */
function takeCount(text) {
  const m = COUNT_RE.exec(text);
  if (!m) {
    if (/^几\s*(?:张|个|份|幅|副)/.test(text)) return { count: 0, rest: text.replace(/^几\s*(?:张|个|份|幅|副)/, '') };
    return { count: 0, rest: text };
  }
  const n = m[1] ? Number(m[1]) : (CN_NUM[m[2]] || 0);
  return { count: n, rest: text.slice(m[0].length) };
}

/**
 * 识别「确定性搜图指令」。
 *
 * @param {string} rawText        消息文本（核心已把段渲染成文本）
 * @param {object} [opts]
 * @param {boolean} [opts.atOthers] 这条消息 @ 了别人（不是机器人）→ 直接不认领
 * @param {string[]} [opts.atNames] 核心收集到的 @ 渲染原文（用于精确剔除）
 * @param {number} [opts.maxLength] 整句长度上限，默认 40
 * @returns {{keyword:string, count:number, lead:string, source:string}|null}
 *          count=0 表示用配置里的默认数量
 */
export function matchSearchCommand(rawText, opts = {}) {
  if (opts.atOthers === true) return null;
  const maxLength = Number(opts.maxLength) > 0 ? Number(opts.maxLength) : 40;

  let text = normalizeSpace(rawText);
  if (!text) return null;
  text = stripMentions(text, opts.atNames);
  text = normalizeSpace(text).replace(NOISE_TAIL, '').trim();
  if (!text || text.length > maxLength) return null;

  // ① 末尾必须是「图 / 图片 / 的图」
  let tail = '';
  for (const t of TAIL_WORDS) {
    if (text.endsWith(t)) { tail = t; break; }
  }
  if (!tail) return null;

  const body = text.slice(0, text.length - tail.length).trim();
  if (!body) return null;
  if (NOT_A_REQUEST.some((re) => re.test(body))) return null;

  // ② 开头必须命中触发词 —— 没命中就**不认领**（「刚刚那张图」不行）
  let lead = '';
  let rest = body;
  for (const word of LEADS) {
    if (body.startsWith(word)) { lead = word; rest = body.slice(word.length).trim(); break; }
  }
  if (!lead) return null;

  // ③ 数量：「来3张」「我要20张」「给我5张」—— 只要紧跟在触发词后面就认。
  //    2026-10-20：以前只在 lead 是"来/给/发/搜/找"时才解析数量，
  //    于是「我要20张高松灯的图」会把 "20张" 当成关键词的一部分（被 5 个上限掩盖了很久）。
  let count = 0;
  {
    const t = takeCount(rest);
    count = t.count;
    rest = t.rest.trim();
  }

  const keyword = stripAbout(stripQuotes(rest));
  if (!keyword) return null;                        // 「来点图」「有没有图」= 没关键词，不认领
  if (keyword.length > 32) return null;
  if (BAD_KEYWORD.test(keyword)) return null;       // 「有没有什么好看的图」不是点图
  if (BAD_CHARS.test(keyword)) return null;
  // 关键词里总得有点"实质内容"。原来是 `[\p{Script=Han}A-Za-z0-9]` —— 只认汉字/拉丁/数字，
  // 于是**假名**（レイジ / ゆかり）、韩文、俄文这类全被判成"没内容"、直接不认领：
  // 2026-10-18 现场「来点レイジ的图」被判"句式不匹配"，可 pixiv 的标签绝大多数是日文。
  // 改成任何语言的字母/数字都算（\p{L} / \p{N}）。
  if (!/[\p{L}\p{N}]/u.test(keyword)) return null;

  // 2026-10-20：数量**不再卡 5**（用户要求"每次搜图没有硬上限"），只留 500 的天窗。
  // 0 仍然是"没明说数量"，由调用方用设置里的默认值。
  return { keyword, count: count > 0 ? Math.min(500, count) : 0, lead, source: 'pattern' };
}

// ── 自测：node search-command.mjs ──────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('search-command.mjs')) {
  const hit = [
    ['我要初音ミク的图', '初音ミク', 0],
    ['我要看初音ミク的图', '初音ミク', 0],
    ['我想看猫娘的图', '猫娘', 0],
    ['来点初音ミク的图', '初音ミク', 0],
    ['来张初音ミク的图', '初音ミク', 0],
    ['有没有初音ミク的图', '初音ミク', 0],
    ['有没有初音ミク的图吗？', '初音ミク', 0],
    ['来3张初音ミク的图', '初音ミク', 3],
    ['来三张初音ミク的图', '初音ミク', 3],
    ['来几张初音ミク的图', '初音ミク', 0],
    ['多来几张初音ミク的图', '初音ミク', 0],
    ['给我来点初音ミク的图', '初音ミク', 0],
    ['求初音ミク的图', '初音ミク', 0],
    ['搜点初音ミク的图', '初音ミク', 0],
    ['@小鲸鱼(QQ:12345) 我要猫娘的图', '猫娘', 0],
    ['@小鲸鱼 来张猫娘的图', '猫娘', 0],
    ['我要「初音ミク」的图', '初音ミク', 0],
    ['我要初音ミク的图片', '初音ミク', 0],
    ['有初音ミク的图吗', '初音ミク', 0],
    // 以下是两个群里**真实出现过**的说法（照抄聊天记录，2026-10-16），
    // 一开始只认五种句式，这些全漏给了模型 —— 现在是必须命中的回归用例。
    ['@大肥鱼 来张陈千语的图', '陈千语', 0],
    ['来2张佩丽卡的图', '佩丽卡', 2],
    ['再来一张topu的图', 'topu', 0],
    ['@大肥鱼 再来点拉普兰德的图', '拉普兰德', 0],   // 2026-10-17 真实现场：这句没认领，漏给了模型
    ['再给我来点猫娘的图', '猫娘', 0],
    ['再多来几张拉普兰德的图', '拉普兰德', 0],
    ['给一个neneg的图片', 'neneg', 0],
    ['给一个neneg的图', 'neneg', 0],
    ['给点蔚蓝档案的图', '蔚蓝档案', 0],
    ['给几张mountainhan的图片', 'mountainhan', 0],
    ['再给几张mountainhan的图片', 'mountainhan', 0],
    ['送我几张MountainHan的图片', 'MountainHan', 0],
    ['给我几张R16的图片', 'R16', 0],
    ['找与pid120514666相关的图片', 'pid120514666', 0],
    ['有没有和风的图', '和风', 0]      // 「和」不当连接词剥掉（关键词真的可能是「和风」）
  ];
  const miss = [
    '刚刚那张图',
    '这张图的链接发我',
    '我要这张图的出处',
    '来点图',
    '有没有图',
    '我要吃饭了',
    '图',
    '我要 初音ミク 的图的链接',
    '有没有什么好看的图',
    '这张图是谁画的',
    '我要看这个视频',
    '同志们来点干劲',
    '发现这张图拍得不错',
    '给点干劲',
    '再来2张',
    '这张图不错',
    '我要 ' + '很长的关键词'.repeat(10) + ' 的图',
  ];
  let bad = 0;
  for (const [text, kw, count] of hit) {
    const r = matchSearchCommand(text);
    const ok = r && r.keyword === kw && r.count === count;
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} ${JSON.stringify(text)} → ${r ? `关键词「${r.keyword}」数量 ${r.count}（触发词 ${r.lead}）` : 'null'}`);
  }
  for (const text of miss) {
    const r = matchSearchCommand(text);
    const ok = r === null;
    if (!ok) bad += 1;
    console.log(`${ok ? '✓' : '✗'} 不该命中 ${JSON.stringify(text)} → ${r ? `「${r.keyword}」` : 'null'}`);
  }
  // @ 别人时不认领
  const atOther = matchSearchCommand('@张三 我要猫娘的图', { atOthers: true });
  if (atOther !== null) bad += 1;
  console.log(`${atOther === null ? '✓' : '✗'} @ 了别人时不认领 → ${atOther ? JSON.stringify(atOther) : 'null'}`);

  console.log(bad === 0 ? '\nPASS 搜图指令识别自测通过' : `\nFAIL ${bad} 项不符合预期`);
  process.exitCode = bad === 0 ? 0 : 1;
}
