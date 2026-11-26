/* 配置页（插件详情里的「配置」/ 设置里的入口）：只放设置本身，其余交给面板。 */
(function () {
  if (window.MagpieUI && document.getElementById('startMode')) {
    window.MagpieUI.mount();
  }
})();
