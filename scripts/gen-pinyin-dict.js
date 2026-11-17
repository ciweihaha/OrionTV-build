// 生成拼音候选词典：从 pinyin-pro 的 dict1（拼音→汉字）反推出无声调拼音→汉字，
// 按常用字频率排序后每音节取前 20 个，输出为 JSON。
// 用法：node scripts/gen-pinyin-dict.js > 输出文件（默认写 utils/pinyinCandidates.json）
const fs = require("fs");
const path = require("path");

// 声调符号 → 无声调（ü 用 v 表示，输入法惯例）
const TONE_MAP = {
  ā: "a", á: "a", ǎ: "a", à: "a",
  ē: "e", é: "e", ě: "e", è: "e",
  ī: "i", í: "i", ǐ: "i", ì: "i",
  ō: "o", ó: "o", ǒ: "o", ò: "o",
  ū: "u", ú: "u", ǔ: "u", ù: "u",
  ǖ: "v", ǘ: "v", ǚ: "v", ǜ: "v", ü: "v",
};

function stripTone(py) {
  let out = "";
  for (const ch of py) out += TONE_MAP[ch] || ch;
  return out;
}

// 常用字频率顺序（现代汉语语料高频字，越靠前越常用；用于候选排序）
const FREQ_ORDER =
  "的一是不了在人有我他这中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用方行所法想实定主样已" +
  "经所长知事都去法家学如都同老天高水小么三两多点心意新文理本明动因果其前力月长当看军然问但气声点头海口山回身意全平话" +
  "文手目山回金白日月水火土木王田心目手足耳口舌牙骨肉皮毛血气力刀弓矢矛戈戟剑盾甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥" +
  "春夏秋冬东南西北前后左右上下内外大小多少长短高低远近快慢轻重厚薄冷热温凉黑白红绿蓝紫青黄粉橙灰银金铜铁锡铅锌铝钢玉珠宝" +
  "一二三四五六七八九十百千万亿兆零壹贰叁肆伍陆柒捌玖拾佰仟万亿" +
  "爱安八爸白百败班般搬板版办半帮包宝报抱北备背本比笔毕闭必边变表别兵病并波播伯博补不布步部才采彩菜参餐草层查察产长常场厂" +
  "唱朝车彻陈晨成程城乘惩澄诚承城吃迟持池驰赤冲充虫崇宠抽出初除厨锄楚础处触川传船窗床创吹春纯唇淳醇蠢戳错措达答打大呆带代" +
  "担单丹胆旦但诞弹当挡党刀导岛倒稻到道德得登灯等低滴敌抵底地弟点典点电店垫定顶东冬懂动栋都斗豆督独读堵赌杜度端短段断" +
  "堆队对顿多躲夺鹅额恶饿恩儿耳二发法帆翻凡烦反返犯饭范贩方防房仿访放飞非菲肥费分纷芬奋份丰风封疯峰锋冯逢缝讽奉佛否夫肤" +
  "扶服浮福富付副傅父复富副盖干甘敢感赶敢刚钢港高搞稿告歌哥格革葛各给根跟更庚耕工功攻供共狗勾沟够古股鼓固故顾瓜挂乖拐" +
  "关观官馆管贯灌光广逛归贵鬼桂滚锅国过哈孩海害含汗汉杭航毫豪好耗号浩河荷核盒贺黑很狠恨哼哄红宏洪烘侯喉猴后厚乎呼忽" +
  "湖胡虎互户护花华滑化画话怀坏欢环还换患唤黄晃灰挥辉回会婚混活火获或惑霍基机积极及级急即集几己记纪技季际剂济既继寄" +
  "加甲佳家假价架驾嫁坚间肩艰监坚减剪简见建健渐江将奖讲交脚角较教接街节结杰今金津斤紧尽进近晋京经精井景静境敬竟竞净" +
  "纠久九酒旧救就居局举句巨具拒距聚君军均俊卡开看康考靠科棵颗刻客课肯垦恳空孔控口苦哭库裤快筷宽款况旷矿亏愧昆捆困扩" +
  "括阔拉辣来赖兰拦蓝览老乐雷冷愣离里理李力历立丽利励利粮两亮谅量聊辽林临邻岭另令刘留流柳六龙楼露录陆路旅律绿虑论" +
  "落妈麻马吗买卖满慢漫忙毛矛冒贸帽么没眉每美妹门们梦迷密秘蜜棉面苗描秒灭民明名命摸模膜磨摩魔末莫墨默谋母目木牧幕" +
  "拿哪那纳奶男难脑闹呢内嫩能你年念娘鸟捏您宁牛农浓弄暖诺女暖欧偶怕拍派盼判胖跑陪培赔佩配喷盆朋鹏碰批皮疲匹片篇骗" +
  "漂票贫品拼平评苹凭瓶迫破七妻期欺齐奇其起气汽器千前钱潜浅欠强墙抢悄桥瞧切且亲勤青轻倾清情请庆穷秋求球区曲取去趣" +
  "全权泉拳犬劝缺确却裙群然燃让饶扰绕热仁认任忍认仍日荣容肉儒软弱若撒洒萨塞赛三散桑扫嫂色森杀沙纱傻晒山闪善扇伤商" +
  "上尚稍烧少绍奢社设身深神审甚生声胜圣剩师失施湿诗石时实食史使始驶士世市示事侍势试视是适室收手首守受售授瘦书" +
  "叔舒输树竖数帅双谁水睡说思死四似寺巳松送搜艘俗素速塑酸算虽随岁碎孙损笋缩所他她它塔踏胎台太态泰贪摊滩坛谈坦探" +
  "汤堂唐糖躺烫逃桃陶讨特疼腾提题踢替天田条跳贴铁厅听停亭庭廷停挺通同童统痛偷头投透图土吐兔团推腿退脱托妥拓挖" +
  "哇娃瓦袜外弯湾玩完晚碗万王往忘望危微为围唯维伟伪尾味未位卫温文闻稳问我握屋无五午武舞勿务误物雾西吸希席洗喜" +
  "系细戏下夏先鲜线限现献乡相香想向象像消小晓笑效校鞋些协写谢新心信星兴行形型醒姓幸性兄胸休修秀锈须需徐许序叙" +
  "宣选旋学雪血寻训讯呀烟盐严言研岩沿演眼扬杨阳羊洋养样邀腰遥咬药要爷野叶夜液一衣依医议易意异益艺亿忆义议亦异" +
  "因音阴姻银引印应英迎盈营影硬映永勇用幽优悠忧尤由邮油游友有又右幼于余鱼愉雨语玉育预欲遇元员原圆源远愿院约月" +
  "云运晕允孕杂灾栽载再在咱赞暂脏造早遭早则责增展占战站张章涨掌丈仗招找照赵这真针侦诊正政证之支汁知直值职植" +
  "止只旨纸指志制至治致中终种重众周州洲舟周粥轴皱朱珠株诸猪竹逐主住注祝驻专转赚装状壮追准桌捉桌着兹资子自字" +
  "总走租足卒族祖组罪尊左作坐座做";

const rank = new Map();
for (let i = 0; i < FREQ_ORDER.length; i++) {
  if (!rank.has(FREQ_ORDER[i])) rank.set(FREQ_ORDER[i], i);
}

const MAX_PER_SYLLABLE = 20;

function main() {
  const dictPath = path.join(__dirname, "..", "node_modules", "pinyin-pro", "dist", "esm", "data", "dict1.mjs");
  // 允许用环境变量指定 dict 路径（本机生成时用 /tmp/pinyin-test 的那份）
  const src = process.env.PINYIN_DICT1 || dictPath;
  const text = fs.readFileSync(src, "utf8");
  // 形如 'bǎng páng pāng': ['膀'], 或 líng: ['〇', '伶', ...]（跨行）
  const re = /['"]?([^'":\n]+)['"]?\s*:\s*\[([\s\S]*?)\]/g;
  const map = new Map(); // toneless -> Map<char, {primary, order}>
  let m;
  let order = 0;
  while ((m = re.exec(text)) !== null) {
    const rawKey = m[1].trim();
    const chars = [];
    const charRe = /'([^']+)'/g;
    let cm;
    while ((cm = charRe.exec(m[2])) !== null) chars.push(cm[1]);
    if (!chars.length) continue;
    // 多音字：key 是空格分隔的多个读音，都归入；第一个读音是常用读音，
    // 其余是生僻/古音——只当候选排序的次要依据，避免 家、她 这类字
    // 因为生僻读音混进 jie 的候选前排。
    const parts = rawKey.split(/\s+/);
    parts.forEach((part, partIdx) => {
      const toneless = stripTone(part);
      if (!toneless || !/^[a-zv]+$/.test(toneless)) return;
      let bucket = map.get(toneless);
      if (!bucket) { bucket = new Map(); map.set(toneless, bucket); }
      for (const ch of chars) {
        const prev = bucket.get(ch);
        // 常用读音优先；同一字多次出现时保留最早的顺序号
        if (!prev || (partIdx === 0 && !prev.primary)) {
          bucket.set(ch, { primary: partIdx === 0, order: prev ? prev.order : order++ });
        }
      }
    });
  }
  const out = {};
  const keys = [...map.keys()].sort();
  for (const k of keys) {
    const entries = [...map.get(k).entries()];
    entries.sort((a, b) => {
      // 常用读音在前；同级按常用字频率；再同级保持 dict 顺序
      if (a[1].primary !== b[1].primary) return a[1].primary ? -1 : 1;
      const ra = rank.has(a[0]) ? rank.get(a[0]) : 1e9;
      const rb = rank.has(b[0]) ? rank.get(b[0]) : 1e9;
      if (ra !== rb) return ra - rb;
      return a[1].order - b[1].order;
    });
    out[k] = entries.slice(0, MAX_PER_SYLLABLE).map(([ch]) => ch);
  }
  const outPath = process.argv[2] || path.join(__dirname, "..", "utils", "pinyinCandidates.ts");
  // 输出为 TS 模块（不用 JSON import，免得依赖 tsconfig 的 resolveJsonModule）
  const ts = `// 拼音候选词典：无声调拼音 -> 常用汉字（按常用度排序，每音节最多 ${MAX_PER_SYLLABLE} 个）。
// 由 scripts/gen-pinyin-dict.js 从 pinyin-pro 的 dict1 生成（pinyin-pro 只在生成时需要，
// 运行时不依赖）；重新生成：PINYIN_DICT1=<dict1.mjs 路径> node scripts/gen-pinyin-dict.js。
// ü 用 v 表示（如 nv=女、lv=绿），与常见输入法惯例一致。
export const PINYIN_CANDIDATES: Record<string, string[]> = ${JSON.stringify(out, null, 0)};
`;
  fs.writeFileSync(outPath, ts);
  const total = Object.values(out).reduce((s, v) => s + v.length, 0);
  console.error(`syllables=${keys.length} totalChars=${total} bytes=${fs.statSync(outPath).size} -> ${outPath}`);
  // 抽查
  for (const k of ["zhong", "guo", "dian", "ying", "jie", "qiang", "nv", "yi", "shi"]) {
    if (out[k]) console.error(k, "=", out[k].join(""));
  }
}

main();
