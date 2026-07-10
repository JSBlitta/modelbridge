import { createApp } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import i18n from './i18n/index.js'
import App from './App.vue'
import router from './router/index.js'

import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import FileUpload from 'primevue/fileupload'
import Toast from 'primevue/toast'
import Dialog from 'primevue/dialog'
import Dropdown from 'primevue/dropdown'
import Tag from 'primevue/tag'
import ProgressBar from 'primevue/progressbar'
import Textarea from 'primevue/textarea'
import Panel from 'primevue/panel'
import Card from 'primevue/card'
import Splitter from 'primevue/splitter'
import SplitterPanel from 'primevue/splitterpanel'
import MultiSelect from 'primevue/multiselect'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import Checkbox from 'primevue/checkbox'
import ToggleButton from 'primevue/togglebutton'
import Message from 'primevue/message'

const app = createApp(App)

app.use(router)
app.use(i18n)
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: { darkModeSelector: '.dark-mode' }
  }
})
app.use(ToastService)
app.use(ConfirmationService)

app.component('DataTable', DataTable)
app.component('Column', Column)
app.component('Button', Button)
app.component('InputText', InputText)
app.component('FileUpload', FileUpload)
app.component('Toast', Toast)
app.component('Dialog', Dialog)
app.component('Dropdown', Dropdown)
app.component('Tag', Tag)
app.component('ProgressBar', ProgressBar)
app.component('Textarea', Textarea)
app.component('Panel', Panel)
app.component('Card', Card)
app.component('Splitter', Splitter)
app.component('SplitterPanel', SplitterPanel)
app.component('MultiSelect', MultiSelect)
app.component('Select', Select)
app.component('InputNumber', InputNumber)
app.component('Checkbox', Checkbox)
app.component('ToggleButton', ToggleButton)
app.component('Message', Message)

app.mount('#app')
