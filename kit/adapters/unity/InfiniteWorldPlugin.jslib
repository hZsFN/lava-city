mergeInto(LibraryManager.library, {
  /* 外链（B 轨）优先走官方 SDK：WL.ready() / WL.complete() / WL.fail()。
   * A 轨 ZIP 或旧协议没有这些方法时，退回 IW_READY / completeLevel / failLevel。 */
  IW_SendReady: function () {
    if (window.__iwUnityListener) return;
    window.__iwUnityListener = true;
    var wl = window.WL;
    if (window.parent === window) {
      if (wl && wl.readSave) SendMessage('InfiniteWorldBridge', 'OnSaveReceived', JSON.stringify(wl.readSave()));
      return;
    }
    if (wl && typeof wl.ready === 'function') {
      wl.ready().then(function (save) {
        SendMessage('InfiniteWorldBridge', 'OnSaveReceived', JSON.stringify(save));
      }).catch(function (error) {
        SendMessage('InfiniteWorldBridge', 'OnHandoffError', String(error && error.message || error));
      });
      return;
    }
    window.addEventListener('message', function (e) {
      if (e.source === window.parent && e.data && e.data.save && (e.data.type === 'IW_INIT_SAVE' || e.data.type === 'iw-init')) {
        SendMessage('InfiniteWorldBridge', 'OnSaveReceived', JSON.stringify(e.data.save));
      }
    });
    window.parent.postMessage({ type: 'IW_READY' }, '*');
  },
  IW_CompleteWithItems: function (reportJsonPtr) {
    var report = JSON.parse(UTF8ToString(reportJsonPtr));
    var wl = window.WL;
    if (wl && typeof wl.complete === 'function') {
      wl.complete(report.save, { acquiredItemIds: report.acquiredItemIds || [] })
        .then(function (receipt) { SendMessage('InfiniteWorldBridge', 'OnHandoffResult', JSON.stringify(receipt)); })
        .catch(function (error) { SendMessage('InfiniteWorldBridge', 'OnHandoffError', String(error && error.message || error)); });
    } else if (wl && typeof wl.completeLevel === 'function') {
      wl.completeLevel(window.CONFIG || {}, report.save, { acquiredItemIds: report.acquiredItemIds || [] });
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_SAVE', save: report.save, acquiredItemIds: report.acquiredItemIds || [] }, '*');
    }
  },
  IW_CompleteLevel: function (saveJsonPtr) {
    var save = JSON.parse(UTF8ToString(saveJsonPtr));
    var wl = window.WL;
    if (wl && typeof wl.completeLevel === 'function') {
      wl.completeLevel(window.CONFIG || {}, save, {
        exitHook: save.exit_hook,
        nextUrl: (window.CONFIG || {}).nextUrl || window.location.href
      });
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_SAVE', save: save }, '*');
    }
  },
  IW_FailLevel: function (reasonPtr, saveJsonPtr) {
    var reason = UTF8ToString(reasonPtr);
    var save = JSON.parse(UTF8ToString(saveJsonPtr));
    var wl = window.WL;
    if (wl && typeof wl.fail === 'function') {
      wl.fail(reason, save, { acquiredItemIds: [] })
        .then(function (receipt) { SendMessage('InfiniteWorldBridge', 'OnHandoffResult', JSON.stringify(receipt)); })
        .catch(function (error) { SendMessage('InfiniteWorldBridge', 'OnHandoffError', String(error && error.message || error)); });
    } else if (wl && typeof wl.failLevel === 'function') {
      wl.failLevel(reason, save, window.CONFIG || {});
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_FAIL', reason: reason, fallenSave: save }, '*');
    }
  }
});
