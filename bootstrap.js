// asks the background to set up this axiom page, retrying every 5 s for 30 s while the worker wakes
(() =>
{
  // sends the setup request
  const send = () =>
  {
    try
    {
      chrome.runtime.sendMessage({ type: "scanpnl.bootstrap" }).catch(() => {});
    }
    catch {}
  };
  send();
  const start = Date.now();

  // repeats the request until 30 s have passed
  const retry = () =>
  {
    if (Date.now() - start > 30000) return;
    send();
    setTimeout(retry, 5000);
  };
  setTimeout(retry, 5000);
})();
