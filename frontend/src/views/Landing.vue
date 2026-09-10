<template>
  <div class="landing">
    <h1 class="landing-title">{{ $t('landing.title') }}</h1>
    <p class="landing-subtitle">{{ $t('landing.subtitle') }}</p>

    <div class="landing-grid">

      <div class="feature-card" @click="$router.push('/import')">
        <div class="feature-icon"><i class="pi pi-upload"></i></div>
        <div class="feature-body">
          <h3>{{ $t('landing.cards.import.title') }}</h3>
          <p>{{ $t('landing.cards.import.desc') }}</p>
          <span class="feature-route">/import</span>
        </div>
      </div>

      <div class="feature-card" @click="$router.push('/trimble')">
        <div class="feature-icon"><i class="pi pi-cloud"></i></div>
        <div class="feature-body">
          <h3>{{ $t('landing.cards.trimble.title') }}</h3>
          <p>{{ $t('landing.cards.trimble.desc') }}</p>
          <span class="feature-route">/trimble</span>
        </div>
      </div>

      <div class="feature-card" @click="$router.push('/batches')">
        <div class="feature-icon"><i class="pi pi-cog"></i></div>
        <div class="feature-body">
          <h3>{{ $t('landing.cards.batches.title') }}</h3>
          <p>{{ $t('landing.cards.batches.desc') }}</p>
          <span class="feature-route">/batches</span>
        </div>
      </div>

      <div class="feature-card" @click="$router.push('/update')">
        <div class="feature-icon"><i class="pi pi-pencil"></i></div>
        <div class="feature-body">
          <h3>{{ $t('landing.cards.update.title') }}</h3>
          <p>{{ $t('landing.cards.update.desc') }}</p>
          <span class="feature-route">/update</span>
        </div>
      </div>

      <div class="feature-card" @click="$router.push('/pdf')">
        <div class="feature-icon"><i class="pi pi-file-pdf"></i></div>
        <div class="feature-body">
          <h3>{{ $t('landing.cards.pdf.title') }}</h3>
          <p>{{ $t('landing.cards.pdf.desc') }}</p>
          <span class="feature-route">/pdf</span>
        </div>
      </div>

    </div>

    <div class="landing-footer">
      <a href="https://produuz.it" target="_blank" rel="noopener noreferrer">
        <i class="pi pi-external-link"></i> {{ $t('landing.openPlatform') }}
      </a>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.landing {
  max-width: 1000px;
  margin: 0 auto;
}

.landing-title {
  font-size: 2rem;
  font-weight: 800;
  color: #e40520;
  margin-bottom: 0.25rem;
}

.landing-subtitle {
  color: #6b7280;
  font-size: 0.95rem;
  margin-bottom: 2rem;
  line-height: 1.5;
}

.landing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.feature-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 1.25rem;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

.feature-card:hover {
  border-color: #e40520;
  box-shadow: 0 4px 12px rgba(228, 5, 32, 0.1);
  transform: translateY(-2px);
}

.feature-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  background: #fef2f2;
  color: #e40520;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.2rem;
  flex-shrink: 0;
}

.feature-body {
  flex: 1;
  min-width: 0;
}

.feature-body h3 {
  font-size: 0.95rem;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 0.35rem;
}

.feature-body p {
  font-size: 0.8rem;
  color: #6b7280;
  line-height: 1.5;
  margin-bottom: 0.4rem;
}

.feature-route {
  font-size: 0.7rem;
  font-family: monospace;
  color: #9ca3af;
  background: #f3f4f6;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

.landing-footer {
  text-align: center;
}

.landing-footer a {
  color: #e40520;
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.landing-footer a:hover {
  text-decoration: underline;
}
</style>

