/**
 * 兜底页逻辑：没有 Node 能力，只能用 location 跳转。
 * 目标地址由主进程通过 query 传入（?url=...）。
 */
(function () {
  var params = new URLSearchParams(window.location.search);
  var target = params.get('url') || 'https://8811.info/app/';
  var code = params.get('code');
  var desc = params.get('desc');

  var detail = document.getElementById('detail');
  if (detail) {
    detail.textContent = code ? '错误码 ' + code + (desc ? ' · ' + desc : '') : '';
  }

  var retry = document.getElementById('retry');
  if (retry) {
    retry.addEventListener('click', function () {
      window.location.replace(target);
    });
  }

  var openWeb = document.getElementById('openWeb');
  if (openWeb) {
    openWeb.addEventListener('click', function () {
      // 兜底页本身没有外链能力，交给主进程的 will-navigate 处理：
      // 站外地址会被拦下并用系统浏览器打开。
      window.location.href = target;
    });
  }
})();
