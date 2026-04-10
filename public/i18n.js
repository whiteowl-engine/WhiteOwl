(function(){
'use strict';
var LANG_KEY='whiteowl_lang';
var savedLang=localStorage.getItem(LANG_KEY)||'en';
var translating=false;
var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,IFRAME:1,CANVAS:1,SVG:1,CODE:1,PRE:1};

var ZH={
"Autonomous Trading AI":"自主交易 AI",
"AI-powered Solana memecoin trading bot with autonomous agents,":"AI 驱动的 Solana 模因币交易机器人，配备自主智能体、",
"real-time analysis, and advanced risk management.":"实时分析和高级风险管理系统。",
"Continue":"继续",
"or connect with":"或通过以下方式登录",
"Continue with GitHub":"使用 GitHub 登录",
"By continuing, your data stays local. No external tracking.":"继续即表示你的数据保留在本地，无外部追踪。",

"Welcome back":"欢迎回来",
"Main":"主要",
"Dashboard":"仪表板",
"AI Chat":"AI 对话",
"Portfolio":"投资组合",
"Wallet":"钱包",
"Tokens":"代币",
"Intelligence":"情报中心",
"AI Activity":"AI 活动",
"Live Events":"实时事件",
"News":"新闻资讯",
"X Tracker":"X 追踪器",
"Agents":"智能体",
"Jobs":"后台任务",
"Shit Trader":"自动交易",
"Tools":"工具箱",
"Skills":"技能",
"Skill Hub":"技能中心",
"Projects":"项目",
"Extension":"浏览器扩展",
"Terminal":"终端",
"Settings":"设置",
"System Online":"系统在线",
"LOCAL":"本地",

"Connecting...":"连接中…",
"Connected":"已连接",
"Disconnected":"已断开",
"Customize":"自定义",

"Welcome to":"欢迎使用",
"Here's a summary of your trading activity":"以下是你的交易活动概览",
"Total P&L":"总盈亏",
"total profit/loss":"总利润/亏损",
"Total Trades":"总交易数",
"trades executed":"已执行交易",
"Win Rate":"胜率",
"success ratio":"成功比率",
"Positions":"持仓",
"active positions":"活跃持仓",
"Session Info":"会话信息",
"Refresh":"刷新",
"Status":"状态",
"Uptime":"运行时间",
"Tokens Scanned":"已扫描代币",
"P&L Chart":"盈亏图表",
"Recent Trades":"最近交易",
"View All":"查看全部",
"Time":"时间",
"Token":"代币",
"Side":"方向",
"Amount":"数量",
"Price":"价格",
"P&L":"盈亏",
"No trades yet":"暂无交易",
"AI Explanations":"AI 解读",
"No AI explanations yet.":"暂无 AI 解读。",
"Loading...":"加载中…",

"History":"历史记录",
"Compact":"紧凑模式",
"summarize old messages to free space":"压缩旧消息以释放空间",
"Context Diagnostics":"上下文诊断",
"New Chat":"新对话",
"Chat History":"对话历史",
"Changes":"变更记录",
"Undo All":"全部撤销",
"Export Diff":"导出差异",
"Quick Links — opens in your browser":"快速链接 — 在浏览器中打开",
"Recent":"最近",
"Sites open in your system browser":"网站将在系统浏览器中打开",
"Show my portfolio":"查看我的投资组合",
"Find trending tokens":"查找热门代币",
"Start monitoring pump.fun":"开始监控 pump.fun",
"What's the market sentiment?":"当前市场情绪如何？",
"Analyze top gainers":"分析涨幅榜",
"Off":"关闭",
"Conservative":"保守",
"Moderate":"适中",
"Aggressive":"激进",
"Full Auto":"全自动",
"Economy (8)":"经济 (8)",
"Balanced (14)":"均衡 (14)",
"Max (40)":"最大 (40)",
"Auto-route":"自动路由",
"Logs":"日志",

"Balance":"余额",
"Address":"地址",
"Click to copy":"点击复制",
"Transactions":"交易记录",
"Network":"网络",
"Wallet Actions":"钱包操作",
"Deposit":"充值",
"Withdraw":"提现",
"Generate New":"生成新钱包",
"Import":"导入",
"Export Private Key":"导出私钥",
"Multisig Vaults":"多签金库",
"Recent Transactions":"最近交易记录",
"Signature":"签名",

"Realized PnL 7d":"7日已实现盈亏",
"Total PnL 7d":"7日总盈亏",
"Winrate":"胜率",
"Buys / Sells":"买入 / 卖出",
"PnL Summary":"盈亏汇总",
"Loading PnL data...":"加载盈亏数据…",
"SPL Token Balances":"SPL 代币余额",
"Trade History":"交易历史",
"Local":"本地",
"Load More":"加载更多",
"Tx":"交易哈希",

"Search":"搜索",
"Loading trending tokens...":"加载热门代币…",

"All":"全部",
"Trades":"交易",
"Signals":"信号",
"Agent":"智能体",
"Risk":"风险",
"Security":"安全",
"Clear":"清除",

"Agent Messages":"智能体消息",
"Message":"消息",
"+ Create Agent":"+ 创建智能体",

"Trading Mode":"交易模式",
"Paper":"模拟",
"Live":"实盘",
"Strategy":"策略",
"Session Controls":"会话控制",
"Duration":"持续时间",
"Start":"启动",
"Stop":"停止",
"Report":"报告",
"Session History":"会话历史",
"Started":"开始时间",
"Mode":"模式",
"Generated Report":"生成报告",

"Background Jobs":"后台任务",
"Clear Inactive":"清除非活跃",
"+ New Job":"+ 新建任务",
"Active":"运行中",
"Paused":"已暂停",
"Completed":"已完成",
"Total Runs":"总运行次数",
"Failed":"失败",
"Rate Limit":"速率限制",
"Create Background Job":"创建后台任务",
"Job Name":"任务名称",
"Task Prompt":"任务提示",
"Run Every (minutes)":"运行间隔（分钟）",
"Total Duration (minutes)":"总时长（分钟）",
"Max Runs (0=unlimited)":"最大运行次数（0=无限）",
"Priority":"优先级",
"Tags (comma-separated)":"标签（逗号分隔）",
"Cancel":"取消",
"Create Job":"创建任务",
"Job Results":"任务结果",

"Autonomous Trading Surface":"自主交易面板",
"OFF":"关闭",
"Start Trader":"启动交易",
"Paper Trading":"模拟交易",
"Set":"设置",
"Sync":"同步",
"Wins":"盈利",
"Losses":"亏损",
"P&L SOL":"盈亏 SOL",
"Best":"最佳",
"Worst":"最差",
"Reset Stats":"重置统计",
"Buys":"买入",
"Sells":"卖出",
"Cycles":"周期",
"Skips":"跳过",
"LLM Calls":"LLM 调用",
"Errors":"错误",
"Loss Streak":"连续亏损",
"Execution Profile":"执行参数",
"Risk Engine":"风险引擎",
"AI Risk Engine":"AI 风险引擎",
"Market Connections":"行情连接",
"AI Thinking":"AI 思考",
"Auto-scroll":"自动滚动",
"Trader is idle":"交易引擎空闲",
"Start the engine to begin autonomous scanning...":"启动引擎以开始自主扫描…",
"Trade Ledger":"交易台账",
"Date":"日期",
"MCap Buy":"买入市值",
"MCap Now":"当前市值",
"MCap Sell":"卖出市值",
"No trades yet. Start the trader to begin execution.":"暂无交易。启动交易引擎以开始执行。",
"Learning Journal":"学习日志",
"Patterns":"模式规律",
"Mistakes":"失误总结",
"Insights":"交易洞见",
"Journal is empty":"日志为空",
"Once the trader executes and reviews positions...":"当交易引擎执行并回顾持仓后…",

"Skills & Tools":"技能与工具",
"Expand All":"展开全部",
"Loading skills...":"加载技能…",

"AI project workspace on your Desktop":"桌面上的 AI 项目工作区",
"+ New File":"+ 新建文件",
"+ New Folder":"+ 新建文件夹",
"Delete":"删除",
"Clean All":"全部清理",
"File":"文件",
"Save":"保存",
"Run":"运行",
"Close":"关闭",
"Execution Output":"执行输出",

"WhiteOwl Overlay for pump.fun":"WhiteOwl pump.fun 插件",
"AI-powered overlay for pump.fun, Trenches, and more":"支持 pump.fun、Trenches 等平台的 AI 插件",
"Not Installed":"未安装",
"Quick Install":"快速安装",
"Download & Install":"下载并安装",
"Download the Installer":"下载安装程序",
"Run the Installer":"运行安装程序",
"Open pump.fun":"打开 pump.fun",
"Technical Info":"技术信息",
"Extension ID":"扩展 ID",
"Server URL":"服务器地址",
"Uninstall Extension":"卸载扩展",
"Token Analysis":"代币分析",
"Live Alerts":"实时提醒",
"Quick Actions":"快捷操作",
"Project Rating":"项目评分",

"Kill":"终止",

"RPC Configuration":"RPC 配置",
"Custom Solana RPC for on-chain verification.":"用于链上验证的自定义 Solana RPC。",
"Solana RPC URL":"Solana RPC 地址",

"Test":"测试",
"Save RPC":"保存 RPC",
"Reset":"重置",
"OAuth / Free AI":"OAuth / 免费 AI",
"AI Model":"AI 模型",
"Choose which AI model powers the chat.":"选择驱动对话的 AI 模型。",
"Reconfigure shell & AI":"重新配置终端和 AI",
"Apply":"应用",
"API Keys":"API 密钥",
"Save Keys":"保存密钥",
"Browser":"浏览器",
"Connect to Chrome":"连接 Chrome",
"X (fallback)":"X（备用方案）",
"Login via Dedicated Browser":"通过专用浏览器登录",
"Check Session":"检查会话",
"Save Cookies":"保存 Cookie",
"System Health":"系统健康",

"Customize UI":"自定义界面",
"Theme Presets":"主题预设",
"Custom Colors":"自定义颜色",
"Layout":"布局",
"Sidebar Position":"侧边栏位置",
"Compact Mode":"紧凑模式",
"Font Size":"字体大小",
"Sidebar Width":"侧边栏宽度",
"Content Padding":"内容边距",
"Border Radius":"圆角大小",
"Navigation Pages":"导航页面",
"Dashboard Widgets":"仪表板组件",
"AI Widget Generator":"AI 组件生成器",
"Describe a widget and AI will generate it":"描述一个组件，AI 将自动生成",
"Generate Widget":"生成组件",
"Custom CSS":"自定义 CSS",
"Reset All":"全部重置",
"Export":"导出",

"News Feed":"新闻动态",
"Crypto":"加密货币",
"Politics":"政治",
"Business":"商业",
"World":"国际",
"Sports":"体育",
"Tech":"科技",
"Science":"科学",
"Entertainment":"娱乐",
"Conflicts":"冲突",
"Elections":"选举",
"Macro":"宏观",
"Regulation":"监管",
"Memes":"模因",
"Loading news...":"加载新闻…",

"Connect to GMGN X Tracker":"连接 GMGN X 追踪器",
"Prerequisite:":"前提条件：",
"Detecting...":"检测中…",
"Auto-Detect WS":"自动检测 WS",
"Connect":"连接",
"or paste URL manually":"或手动粘贴地址",
"How it works:":"工作原理：",
"1. Be logged into gmgn.ai in Chrome":"1. 在 Chrome 中登录 gmgn.ai",
"2. Click Auto-Detect — opens GMGN X Tracker":"2. 点击自动检测 — 打开 GMGN X 追踪器",
"3. Extension captures the WS URL automatically":"3. 扩展自动获取 WS 地址",
"Disconnect":"断开连接",

"AI Activity Log":"AI 活动日志",
"Waiting for AI activity...":"等待 AI 活动…",
"Start agents or send a chat message to see activity":"启动智能体或发送消息以查看活动",
"LLM Response":"LLM 响应",
"Copy text":"复制文本",

"Copy":"复制",
"Copied!":"已复制！",
"Error":"错误",
"Success":"成功",
"Warning":"警告",
"Info":"信息",
"Confirm":"确认",
"Yes":"是",
"No":"否",
"OK":"确定",
"Loading":"加载中",
"Retry":"重试",
"Back":"返回",
"Next":"下一步",
"Previous":"上一步",
"Submit":"提交",
"Edit":"编辑",
"Update":"更新",
"Remove":"移除",
"Add":"添加",
"Enable":"启用",
"Disable":"禁用",
"On":"开启",
"Enabled":"已启用",
"Disabled":"已禁用",
"None":"无",
"Default":"默认",
"Custom":"自定义",
"Select":"选择",
"Open":"打开",
"Send":"发送",
"Sent":"已发送",
"Pending":"待处理",
"Processing":"处理中",
"Done":"完成",
"Ready":"就绪",
"Idle":"空闲",
"Running":"运行中",
"Stopped":"已停止",
"Online":"在线",
"Offline":"离线",
"Unknown":"未知",

"Prerequisite:":"前提条件：",
"Ready:":"就绪：",
"Connect to your Chrome browser first (remote debugging via CDP).":"请先连接你的 Chrome 浏览器（通过 CDP 远程调试）。",
"Connect to Chrome":"连接 Chrome",
"Chrome CDP active":"Chrome CDP 已激活",
"Automatically connects to your GMGN session via Chrome and captures the WebSocket URL.":"自动通过 Chrome 连接你的 GMGN 会话并获取 WebSocket 地址。",
"Connect to GMGN X Tracker":"连接 GMGN X 追踪器",
"Auto-Detect WS":"自动检测 WS",
"or paste URL manually":"或手动粘贴地址",
"One-click connect to your Chrome via CDP. All sessions (Twitter, Axiom, GMGN) become available instantly.":"一键通过 CDP 连接 Chrome。所有会话（Twitter、Axiom、GMGN）即可使用。",

"▲ Bullish":"▲ 看涨",
"▼ Bearish":"▼ 看跌",
"● Neutral":"● 中性",
"s ago":"秒前",
"m ago":"分钟前",
"h ago":"小时前",
"d ago":"天前",
"new headline":"条新资讯",
"new headlines":"条新资讯",
"No news in this category":"该分类暂无新闻",
"SOL":"SOL",
"DeFi":"DeFi",
"Macro":"宏观",
"Reg":"监管",
"Meme":"模因",
"Hack":"黑客",
"Politics":"政治",
"Sports":"体育",
"Tech":"科技",
"Biz":"商业",
"World":"国际",
"Science":"科学",
"Ent":"娱乐",
"Conflict":"冲突",
"Election":"选举",
"Weather":"天气",
"Crypto":"加密货币"
};

var ZH_PH={
"Search anything...":"搜索任何内容…",
"Enter your name to continue...":"请输入你的名字以继续…",
"Search by address, symbol or name...":"按地址、符号或名称搜索…",
"Ask WhiteOwl anything... (type @ to mention files)":"向 WhiteOwl 提问…（输入 @ 引用文件）",
"Enter URL and press Enter to open in your browser...":"输入网址并按回车以在浏览器中打开…",
"e.g., Twitter Monitor":"例如：Twitter 监控",
"e.g., Read the X Tracker feed...":"例如：读取 X 追踪器信息流…",
"Filter by @handle, keyword, or paste tweet URL...":"按 @用户、关键词或推文链接筛选…",
"Search skills or tools...":"搜索技能或工具…",
"e.g. show my SOL balance with auto-refresh every 30 seconds":"例如：显示我的 SOL 余额并每 30 秒自动刷新",
"https://api.mainnet-beta.solana.com":"https://api.mainnet-beta.solana.com",
"https://mainnet.helius-rpc.com/?api-key=YOUR_KEY":"https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
"auth_token=xxx; ct0=yyy":"auth_token=xxx; ct0=yyy"
};

var EN={};
Object.keys(ZH).forEach(function(k){EN[ZH[k]]=k;});
var EN_PH={};
Object.keys(ZH_PH).forEach(function(k){if(ZH_PH[k]!==k)EN_PH[ZH_PH[k]]=k;});

function translateNode(root,dict,phDict){
  if(!root||!root.nodeType)return;
  if(root.nodeType===3){
    var t=root.textContent.trim();
    if(t&&dict[t])root.textContent=root.textContent.replace(t,dict[t]);
    return;
  }
  if(root.nodeType!==1)return;
  if(SKIP[root.tagName])return;

  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null,false);
  var node,nodes=[];
  while(node=walker.nextNode()){
    if(node.parentElement&&SKIP[node.parentElement.tagName])continue;
    nodes.push(node);
  }
  for(var i=0;i<nodes.length;i++){
    var txt=nodes[i].textContent.trim();
    if(!txt||/^[\d\$\.\,\%\-\+\:\s\/]+$/.test(txt))continue;
    if(dict[txt]){
      nodes[i].textContent=nodes[i].textContent.replace(txt,dict[txt]);
    }
  }

  var inputs=root.querySelectorAll('input[placeholder],textarea[placeholder]');
  for(var j=0;j<inputs.length;j++){
    var ph=inputs[j].getAttribute('placeholder');
    if(ph&&phDict[ph])inputs[j].setAttribute('placeholder',phDict[ph]);
  }

  var titled=root.querySelectorAll('[title]');
  for(var k=0;k<titled.length;k++){
    var ti=titled[k].getAttribute('title');
    if(ti&&dict[ti])titled[k].setAttribute('title',dict[ti]);
  }
}

function translateAll(lang){
  if(translating)return;
  translating=true;
  try{
    var dict=lang==='zh'?ZH:EN;
    var phDict=lang==='zh'?ZH_PH:EN_PH;
    translateNode(document.body,dict,phDict);
    var btn=document.getElementById('langToggle');
    if(btn)btn.textContent=lang==='zh'?'EN':'中文';
    savedLang=lang;
    localStorage.setItem(LANG_KEY,lang);
  }finally{translating=false;}
}

var observer;
function startObserver(){
  if(observer)return;
  observer=new MutationObserver(function(mutations){
    if(savedLang!=='zh'||translating)return;
    var added=[];
    for(var i=0;i<mutations.length;i++){
      var m=mutations[i];
      if(m.type==='childList'){
        for(var j=0;j<m.addedNodes.length;j++){
          var n=m.addedNodes[j];
          if(n.nodeType===1&&!SKIP[n.tagName])added.push(n);
          else if(n.nodeType===3){
            var t=n.textContent.trim();
            if(t&&ZH[t])n.textContent=n.textContent.replace(t,ZH[t]);
          }
        }
      }
    }
    if(added.length){
      clearTimeout(observer._t);
      var nodesToTranslate=added.slice();
      observer._t=setTimeout(function(){
        for(var k=0;k<nodesToTranslate.length;k++){
          translateNode(nodesToTranslate[k],ZH,ZH_PH);
        }
      },60);
    }
  });
  observer.observe(document.body,{childList:true,subtree:true});
}

window.I18N={
  apply:translateAll,
  current:function(){return savedLang;},
  t:function(key){return savedLang==='zh'&&ZH[key]?ZH[key]:key;},
  refresh:function(){if(savedLang==='zh')translateAll('zh');}
};

window.toggleLang=function(){
  translateAll(savedLang==='en'?'zh':'en');
};

function init(){
  startObserver();
  if(savedLang==='zh')setTimeout(function(){translateAll('zh');},120);
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',init);
}else{init();}
})();
