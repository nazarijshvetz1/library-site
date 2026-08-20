window.LIBRARY_CONFIG = Object.freeze({
  // Публічний каталог читає актуальні дані безпосередньо з D1 через Sites API.
  catalogApiUrl: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/api/catalog-v2",
  // Публічний графік містить лише години та зайняті інтервали, без персональних даних.
  visitsApiUrl: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/api/visits/public",
  // Заявки створюються лише після переходу до захищеного кабінету.
  visitsBookingUrl: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/teacher",
  teacherPortalUrl: "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/teacher",
  refreshMinutes: 10,
});
