import { createApp } from 'vue'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ToastService from 'primevue/toastservice'
import ConfirmationService from 'primevue/confirmationservice'
import i18n from './i18n/index.js'
import App from './App.vue'
import './assets/app.css'
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
import Textarea from 'primevue/textarea'
import Card from 'primevue/card'
import Select from 'primevue/select'
import InputNumber from 'primevue/inputnumber'
import Checkbox from 'primevue/checkbox'
import Message from 'primevue/message'
import Divider from 'primevue/divider'

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
app.component('Textarea', Textarea)
app.component('Card', Card)
app.component('Select', Select)
app.component('InputNumber', InputNumber)
app.component('Checkbox', Checkbox)
app.component('Message', Message)
app.component('Divider', Divider)

app.mount('#app')
