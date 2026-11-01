/**
 * 生成测试用电子书样本（TXT / EPUB / CBZ / PDF）
 * 仅在本地开发验证使用，不随插件发布
 */
import JSZip from 'jszip'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const OUT = 'fixtures'
mkdirSync(OUT, { recursive: true })

/* ---------- 极简 PNG 编码器（仅用于生成测试图片） ---------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** 生成 RGB 图片（pixel 回调返回 [r,g,b]） */
function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      raw[offset] = r
      raw[offset + 1] = g
      raw[offset + 2] = b
      offset += 3
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- TXT ----------
const txt = [
  '第一章 起点',
  '',
  '清晨的风穿过窗棂，落在摊开的书页上。',
  '他抬起头，看见远处的山脊被阳光一层层点亮。',
  '',
  '这是故事的开始，也是一切问题浮现的地方。',
  '',
  '第二章 迷雾',
  '',
  '雾在河谷里堆积，像一层柔软的棉絮。',
  '有人在雾中行走，脚步声被吞没。',
  '',
  '第三章 回声',
  '',
  '回声从岩壁折返，带来很久以前的回答。',
  '他想，也许所有问题都需要时间来作答。',
].join('\n')
writeFileSync(join(OUT, 'novel.txt'), txt, 'utf-8')

// ---------- EPUB ----------
const zip = new JSZip()
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
zip.file(
  'META-INF/container.xml',
  `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
)

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>测试之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
zip.file('OEBPS/content.opf', opf)

zip.file(
  'OEBPS/nav.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc"><h1>目录</h1>
    <ol>
      <li><a href="ch1.xhtml">第一章 光的方向</a></li>
      <li><a href="ch2.xhtml">第二章 雾的重量</a></li>
    </ol>
  </nav>
</body></html>`,
)

zip.file('OEBPS/style.css', 'p{text-indent:2em;margin:0 0 1em;} h1{font-size:1.4em;}')

zip.file(
  'OEBPS/ch1.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>第一章 光的方向</h1>
  <p>光从东边的山口升起，照亮了整片稻田。</p>
  <p>他站在田埂上，手里握着一本旧书。</p>
  <p><img src="images/cover.png" alt="插图"/></p>
</body></html>`,
)

zip.file(
  'OEBPS/ch2.xhtml',
  `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>第二章 雾的重量</h1>
  <p>雾落在肩上，像一层看得见摸不着的重量。</p>
  <p>他继续向前走，脚下的路一点点清晰。</p>
</body></html>`,
)

// 封面：600×800 渐变图
const png = makePng(600, 800, (x, y) => {
  const t = y / 800
  return [Math.round(79 + 60 * t), Math.round(124 + 20 * t), Math.round(255 - 40 * t)]
})
zip.file('OEBPS/images/cover.png', png)

const epubBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(join(OUT, 'book.epub'), epubBuffer)

// ---------- CBZ ----------
const cbz = new JSZip()
const PAGE_COLORS = [
  [244, 241, 234],
  [234, 240, 244],
  [244, 236, 240],
]
for (let i = 1; i <= 3; i += 1) {
  const base = PAGE_COLORS[i - 1]
  const page = makePng(800, 1200, (x, y) => {
    // 边框 + 3 行内容色块，模拟漫画分镜
    if (x < 14 || x > 786 || y < 14 || y > 1186) return [40, 44, 52]
    const panel = Math.floor((y - 40) / 360)
    const inPanel = y > 40 + panel * 360 && y < 40 + panel * 360 + 300
    if (inPanel && x > 40 && x < 760) {
      const shade = 0.55 + panel * 0.12
      return [Math.round(base[0] * shade), Math.round(base[1] * shade), Math.round(base[2] * shade)]
    }
    return base
  })
  cbz.file(`${String(i).padStart(2, '0')}.png`, page)
}
writeFileSync(join(OUT, 'comic.cbz'), await cbz.generateAsync({ type: 'nodebuffer' }))

// ---------- PDF（手写最小合法结构） ----------
/** 把手写对象体组装成合法 PDF：xref 偏移必须精确，统一在这里算 */
function assemblePdf(bodies, infoObjectNo) {
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= bodies.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const info = infoObjectNo ? ` /Info ${infoObjectNo} 0 R` : ''
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

const content = `BT /F1 24 Tf 40 700 Td (Sample PDF Book) Tj ET
BT /F1 14 Tf 40 660 Td (Page one content for reader test.) Tj ET`
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]

writeFileSync(join(OUT, 'doc.pdf'), assemblePdf(objects))

// ---------- 多页 PDF（验证单页 / 双页翻页控件与进度） ----------
const MULTI_PAGES = 6
const multiBodies = []
multiBodies[0] = '<< /Type /Catalog /Pages 2 0 R >>'
const multiKids = []
for (let i = 0; i < MULTI_PAGES; i += 1) multiKids.push(`${3 + i * 2} 0 R`)
multiBodies[1] = `<< /Type /Pages /Kids [${multiKids.join(' ')}] /Count ${MULTI_PAGES} >>`
const multiFontNo = 3 + MULTI_PAGES * 2
for (let i = 0; i < MULTI_PAGES; i += 1) {
  const contentNo = 4 + i * 2
  const text = `BT /F1 34 Tf 60 700 Td (Page ${i + 1} of ${MULTI_PAGES}) Tj ET`
  multiBodies[2 + i * 2] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
    `/Resources << /Font << /F1 ${multiFontNo} 0 R >> >> /Contents ${contentNo} 0 R >>`
  multiBodies[3 + i * 2] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`
}
multiBodies[multiFontNo - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
// 故意塞一个 Word 导出风格的旧标题：验证「书名以文件名为准，不被内嵌元数据顶掉」
const multiInfoNo = multiFontNo + 1
multiBodies[multiInfoNo - 1] = '<< /Title (Microsoft Word - Legacy Title.docx) /Author (Fixture Author) >>'
writeFileSync(join(OUT, 'multi.pdf'), assemblePdf(multiBodies, multiInfoNo))

// ---------- 中文 PDF（Type0 + 预定义 CMap，用于验证中文乱码修复） ----------
// 真实中文 PDF 的典型结构：Type0 复合字体 + /Encoding /UniGB-UCS2-H，
// 文字用 UTF-16BE 十六进制串书写，CID→Unicode 全靠 pdf.js 加载 Adobe-GB1 的 .bcmap。
// 缺 CMap 时这段文字会变成乱码或空 —— 正是本次要修的问题。
const utf16Hex = (text) =>
  Array.from(text)
    .map((ch) => ch.codePointAt(0).toString(16).padStart(4, '0'))
    .join('')
    .toUpperCase()

const cnLines = [
  { size: 22, y: 760, text: '电子书阅读器' },
  { size: 14, y: 720, text: '中文乱码验证：简体中文排版' },
  { size: 14, y: 695, text: '标点，句号。书名号《测试》与数字 2026' },
]
const cnContent = cnLines
  .map(
    (l) =>
      `BT /F1 ${l.size} Tf 60 ${l.y} Td <${utf16Hex(l.text)}> Tj ET`,
  )
  .join('\n')

const cnObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(cnContent, 'latin1')} >>\nstream\n${cnContent}\nendstream`,
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>',
  '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 93 >>',
]

let cnPdf = '%PDF-1.4\n'
const cnOffsets = [0]
cnObjects.forEach((body, index) => {
  cnOffsets.push(cnPdf.length)
  cnPdf += `${index + 1} 0 obj\n${body}\nendobj\n`
})
const cnXref = cnPdf.length
cnPdf += `xref\n0 ${cnObjects.length + 1}\n0000000000 65535 f \n`
for (let i = 1; i <= cnObjects.length; i += 1) {
  cnPdf += `${String(cnOffsets[i]).padStart(10, '0')} 00000 n \n`
}
cnPdf += `trailer\n<< /Size ${cnObjects.length + 1} /Root 1 0 R >>\nstartxref\n${cnXref}\n%%EOF\n`
writeFileSync(join(OUT, 'cn.pdf'), Buffer.from(cnPdf, 'latin1'))

console.log(
  'fixtures ready:',
  ['novel.txt', 'book.epub', 'comic.cbz', 'doc.pdf', 'multi.pdf', 'cn.pdf'].join(', '),
)

/* ---------- 编码类样本：验证非 UTF-8 文本不乱码 ---------- */

/**
 * GB18030 / GBK 编码器
 * Node 只内置解码、不内置编码，这里反过来把 GB18030 的双字节空间遍历一遍建表
 */
const GBK_MAP = (() => {
  const decoder = new TextDecoder('gb18030')
  const map = new Map()
  for (let hi = 0x81; hi <= 0xfe; hi += 1) {
    for (let lo = 0x40; lo <= 0xfe; lo += 1) {
      const ch = decoder.decode(Uint8Array.of(hi, lo))
      if (ch.length === 1 && ch !== '\ufffd' && !map.has(ch)) map.set(ch, [hi, lo])
    }
  }
  return map
})()

/** 文本 → GBK 字节；未收录字符用 '?' 代替 */
function gbkBytes(text) {
  const out = []
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code < 0x80) out.push(code)
    else {
      const pair = GBK_MAP.get(ch)
      if (pair) out.push(pair[0], pair[1])
      else out.push(0x3f)
    }
  }
  return Buffer.from(out)
}

/** 文本 → windows-1251 字节（西里尔字母区间线性映射） */
function cp1251Bytes(text) {
  return Buffer.from(
    Array.from(text, (ch) => {
      const code = ch.codePointAt(0)
      if (code < 0x80) return code
      if (code >= 0x0410 && code <= 0x044f) return code - 0x0410 + 0xc0
      if (code === 0x0401) return 0xa8
      if (code === 0x0451) return 0xb8
      return 0x3f
    }),
  )
}

// 1) GBK 编码的 TXT
writeFileSync(
  join(OUT, 'gbk-txt.txt'),
  gbkBytes(
    '第一章 山间的清晨\n清晨的风从山谷里穿过，带着松针的气味。\n他合上书，听见远处传来钟声。\n\n第二章 河岸\n河水在石头上碎成细小的光。\n',
  ),
)

// 2) GBK 编码的 EPUB（XHTML 声明 gbk），验证 readZipText 的编码嗅探
const gbkEpub = new JSZip()
gbkEpub.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
gbkEpub.file(
  'META-INF/container.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
)
gbkEpub.file(
  'OEBPS/content.opf',
  `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>GBK 编码之书</dc:title><dc:creator>编码测试</dc:creator><dc:language>zh-CN</dc:language>
    <dc:identifier id="id">urn:uuid:gbk-0001</dc:identifier>
  </metadata>
  <manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
)
gbkEpub.file(
  'OEBPS/ch1.xhtml',
  gbkBytes(`<?xml version="1.0" encoding="gbk"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="gbk"/><title>第一章</title></head>
<body><h1>第一章 竹林</h1>
<p>竹叶在风里翻了个身，露出背面的银白色。</p>
<p>他把竹简摊在石桌上，逐个辨认上面的字。</p>
</body></html>`),
)
writeFileSync(join(OUT, 'gbk-epub.epub'), await gbkEpub.generateAsync({ type: 'nodebuffer' }))

// 3) windows-1251 编码的 FB2（俄文），验证 XML 声明嗅探
writeFileSync(
  join(OUT, 'ru.fb2'),
  cp1251Bytes(`<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info>
    <book-title>Тестовая книга</book-title>
    <author><first-name>Иван</first-name><last-name>Петров</last-name></author>
    <lang>ru</lang>
  </title-info></description>
  <body><section><title><p>Глава первая</p></title>
    <p>Утро было тихим, и река блестела на солнце.</p>
  </section></body>
</FictionBook>`),
)

// 4) \ansicpg936 的 RTF（\'hh 十六进制中文 + \uN 转义），验证码表识别
const toRtfHex = (text) =>
  Array.from(gbkBytes(text), (b) => `\\'${b.toString(16).padStart(2, '0')}`).join('')
const rtfDoc = [
  '{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}',
  '\\f0\\fs24 ',
  toRtfHex('中文段落：山间的清晨'),
  '\\par ',
  toRtfHex('第二段：'),
  '\\u27743?\\u27827?',
  '\\par}',
].join('')
writeFileSync(join(OUT, 'cp936.rtf'), Buffer.from(rtfDoc, 'latin1'))
