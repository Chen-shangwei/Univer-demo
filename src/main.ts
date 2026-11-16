import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
// Element Plus 全量样式必须先于业务样式引入，app.css 里按需要覆盖其变量
import 'element-plus/dist/index.css'
import './style.css'
// Univer 的组件样式必须手动引入，否则工具栏/ ribbon 会竖排堆叠
// 引入顺序不可调整：design 是基础令牌，后续包都建立在它之上
import '@univerjs/design/lib/index.css'
import '@univerjs/ui/lib/index.css'
import '@univerjs/docs-ui/lib/index.css'
import '@univerjs/sheets-ui/lib/index.css'
import '@univerjs/sheets-formula-ui/lib/index.css'
import '@univerjs/sheets-numfmt-ui/lib/index.css'
import './styles/app.css'
import App from './App.vue'
import { router } from './router'

/**
 * 全局尺寸取 Element Plus 的 default（控件高 32px、正文 14px），
 * 表格行内与工具栏的密集按钮在模板里单独声明 size="small"。
 */
createApp(App)
  .use(router)
  .use(ElementPlus, { locale: zhCn, size: 'default', zIndex: 2000 })
  .mount('#app')
