/** Display-only benefits and criteria matching current implementation; no rule changes. */
export type TechnicalAuditBenefitLevel = '高' | '中' | '低'

export type TechnicalAuditHelp = { geoBenefit: string; passCriteria: string; benefitLevel: TechnicalAuditBenefitLevel }

/** Relative potential technical impact, not measured GEO uplift or audit status. */
export const TECHNICAL_AUDIT_HELP: Record<string, TechnicalAuditHelp> = {
  "site.dns": {
    "geoBenefit": "减少因域名无法解析造成的抓取失败，为官网内容被检索系统发现、读取和用于回答提供访问基础。",
    "passCriteria": "官网域名能够正常解析，并取得有效的解析结果。",
    "benefitLevel": "高"
  },
  "site.https": {
    "geoBenefit": "减少证书或安全连接异常造成的抓取中断，让检索系统更顺畅地访问官网，为获取内容提供连接保障。",
    "passCriteria": "官网使用HTTPS，能建立可信的安全连接；证书未过期、与访问域名匹配，证书链可信。",
    "benefitLevel": "高"
  },
  "site.http_status": {
    "geoBenefit": "减少首页错误响应造成的访问障碍，为检索系统从官网入口获取品牌和业务信息提供基础。",
    "passCriteria": "官网首页能返回最终响应，且HTTP状态码低于400。仅检查首页，不受内页状态影响。",
    "benefitLevel": "高"
  },
  "site.redirect": {
    "geoBenefit": "减少检索系统在首页跳转过程中失去访问目标的情况，让内容发现流程能够继续到达最终页面。",
    "passCriteria": "官网首页无需跳转，或跳转能够正常完成；不存在循环跳转、无效跳转地址或未完成的跳转。",
    "benefitLevel": "高"
  },
  "crawl.robots_txt": {
    "geoBenefit": "减少通用抓取规则对公开页面的限制，为遵循这些规则的检索服务获取官网内容、建立检索来源提供条件。",
    "passCriteria": "网站没有robots.txt文件，或文件能正常读取且通用抓取规则未禁止检查范围内的页面。无需专门添加允许抓取的声明。",
    "benefitLevel": "高"
  },
  "crawl.login": {
    "geoBenefit": "让无需登录的检索服务也能获取公开正文，减少因身份门槛导致的信息缺失，为内容参与检索和回答提供基础。",
    "passCriteria": "检查范围内的页面均能在未登录状态下正常读取公开正文，没有阻断正文的登录要求或验证替代页。",
    "benefitLevel": "高"
  },
  "index.noindex": {
    "geoBenefit": "减少禁止索引指令对公开内容的限制，为页面进入可检索的信息范围、成为回答的候选来源提供条件。",
    "passCriteria": "检查范围内的页面均能正常读取，所检查的索引指令中没有noindex限制。",
    "benefitLevel": "高"
  },
  "index.x_robots_tag": {
    "geoBenefit": "减少响应头中限制性指令对内容索引和使用的约束，为公开信息被检索系统读取和利用提供条件。",
    "passCriteria": "检查范围内的页面均能正常读取；响应头没有X-Robots-Tag，或其中仅包含允许索引、跟踪链接的无约束指令。",
    "benefitLevel": "高"
  },
  "index.snippet": {
    "geoBenefit": "减少禁止摘要指令对内容摘录和展示的限制，为检索摘要及回答中的内容引用提供更充分的使用空间。",
    "passCriteria": "检查范围内的页面均能正常读取，页面及响应头中没有禁止摘要或将摘要长度设为零的指令。",
    "benefitLevel": "中"
  },
  "canonical.target": {
    "geoBenefit": "为同一内容提供明确的规范来源地址，有助于检索系统识别应采用的网址，减少来源归属和引用地址的歧义。",
    "passCriteria": "检查范围内的页面均能正常读取并声明规范网址，且规范网址与官网的协议、域名和端口一致；已检查的目标没有访问错误。范围外的目标不验证访问结果。",
    "benefitLevel": "中"
  },
  "canonical.domain_conflict": {
    "geoBenefit": "减少规范网址在协议、域名或端口上的指向分歧，有助于检索系统将官网内容关联到一致的来源。",
    "passCriteria": "检查范围内的页面均能正常读取，已声明的规范网址没有指向与官网不同的协议、域名或端口。",
    "benefitLevel": "中"
  },
  "links.broken": {
    "geoBenefit": "减少检索系统沿站内链接进入失效页面的情况，有助于保持内容发现路径连贯，便于获取相关补充信息。",
    "passCriteria": "检查范围内的页面均能正常读取，至少一个站内链接目标完成检查，且已检查目标没有访问错误或页面不存在的情况。没有站内链接时记为不适用。",
    "benefitLevel": "中"
  },
  "links.navigation": {
    "geoBenefit": "可识别的导航入口有助于检索系统发现主要栏目和业务页面，为建立网站内容之间的关联提供路径。",
    "passCriteria": "检查范围内的页面均能正常读取，已识别的导航入口没有用途不明的脚本链接或无对应目标的页内锚点；明确的菜单控件和返回页首入口可接受。",
    "benefitLevel": "中"
  },
  "links.pagination": {
    "geoBenefit": "可识别的分页入口有助于检索系统继续发现后续列表内容，减少只获取第一页信息造成的内容遗漏。",
    "passCriteria": "检查范围内的页面均能正常读取，已识别的分页入口没有用途不明的脚本链接或无对应目标的页内锚点；明确的交互控件可接受。没有分页入口时记为不适用。",
    "benefitLevel": "中"
  },
  "sitemap.generation": {
    "geoBenefit": "为支持Sitemap的检索系统提供集中发现网址的入口，有助于发现站内链接层级较深或入口较少的内容。",
    "passCriteria": "至少找到一个可正常读取和解析的XML站点地图；本次检查的文件结构有效，每个网址或子地图条目都包含非空地址。",
    "benefitLevel": "中"
  },
  "sitemap.coverage": {
    "geoBenefit": "将目标页面纳入Sitemap，有助于检索系统发现这批内容，减少页面未出现在网址清单中造成的发现遗漏。",
    "passCriteria": "检查范围内的页面和站点地图均能正常读取，所有被检查页面的路径都包含在已读取的站点地图中。",
    "benefitLevel": "中"
  },
  "sitemap.invalid_urls": {
    "geoBenefit": "减少Sitemap将检索请求引向格式错误或失效地址的情况，让网址发现清单更适合作为有效内容的访问入口。",
    "passCriteria": "站点地图可正常读取，所列地址格式正确并与官网的协议、域名和端口一致；已检查的目标没有访问错误或页面不存在的情况。",
    "benefitLevel": "中"
  },
  "sitemap.lastmod": {
    "geoBenefit": "提供机器可读取的更新时间线索，为检索系统判断内容变化和安排后续抓取提供参考，有助于内容更新后的发现流程。",
    "passCriteria": "能取得页面内容并正常读取站点地图；地图中至少有一个更新时间，且所有已填写的更新时间都能被识别为有效日期。",
    "benefitLevel": "低"
  },
  "discovery.llms_txt": {
    "geoBenefit": "为支持读取此类文件的AI检索工具提供网站说明和内容入口，帮助定位相关页面，减少理解网站内容组织方式的成本。",
    "passCriteria": "可正常读取llms.txt，编码有效、内容非空、不是HTML页面，且包含Markdown一级标题。文件缺失、内容不符合上述条件，或超时、网络失败等无法确认时，均记为待修复；不以文件内链接检查结果作为通过条件。",
    "benefitLevel": "低"
  },
  "content.html_body": {
    "geoBenefit": "为自动化检索提供初始HTML中的文本来源，减少只获得空白内容的情况，为后续文本分析和信息提取提供基础。",
    "passCriteria": "检查范围内的页面均能正常读取，页面HTML的主体部分包含非空文本。",
    "benefitLevel": "高"
  },
  "content.javascript_render": {
    "geoBenefit": "让不执行JavaScript的检索服务也能直接读取正文，减少动态渲染造成的信息缺失，为内容理解和回答取材提供更完整的输入。",
    "passCriteria": "检查范围内的页面均能正常读取，不执行JavaScript也能从初始HTML中取得公开正文，而不是只有导航、表单、提示或空壳内容。",
    "benefitLevel": "高"
  },
  "content.html_structure": {
    "geoBenefit": "提供可识别的页面基础结构，便于检索工具定位头部信息和文本内容，为后续解析、主题识别和信息提取提供基础。",
    "passCriteria": "检查范围内的页面均能正常读取，HTML中具备页面根节点、头部和主体三个基础结构。",
    "benefitLevel": "低"
  },
  "content.metadata": {
    "geoBenefit": "为检索系统提供页面标题和简介线索，有助于识别内容主题、区分不同页面，并为摘要展示和来源选择提供参考。",
    "passCriteria": "检查范围内的页面均能正常读取，HTML中包含标题元素和非空的页面描述。",
    "benefitLevel": "中"
  },
  "content.structured_data": {
    "geoBenefit": "让支持结构化数据的检索工具更容易读取页面中的机器可读信息，减少因标记缺失或基础语法错误造成的实体与属性提取失败。",
    "passCriteria": "本项是结构化数据的存在性与基础解析检查：结构化数据仅检查范围内每个页面是否具备至少一种可识别的实际JSON-LD、Microdata或RDFa标记，以及发现的标记能否通过基础解析。JSON-LD仅检查JSON语法和非空声明识别，不展开远程上下文；本项不代表完整JSON-LD或Schema规范、类型适用性、字段完整性、实体冲突、语义一致性或平台富媒体规则校验。",
    "benefitLevel": "中"
  }
}
