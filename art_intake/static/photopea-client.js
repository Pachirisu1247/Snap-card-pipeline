const WORK_ART_PREFIX = '__ART_DESK_WORK_ART__';
const IMPORT_MARKER = '__ART_DESK_IMPORT__';

export class PhotopeaClient {
  constructor(iframe, callbacks = {}) {
    this.iframe = iframe;
    this.onStatus = callbacks.onStatus || (() => {});
    this.onReady = callbacks.onReady || (() => {});
    this.onPreview = callbacks.onPreview || (() => {});
    this.onError = callbacks.onError || (() => {});
    this.window = null;
    this.ready = false;
    this.phase = 'idle';
    this.run = 0;
    this.workRun = 0;
    this.workCache = null;
    this.workRequest = null;
    this.pendingPsd = null;
    this.pendingArt = null;
    this.pendingCrop = null;
    this.prefetched = null;
    this.prefetching = null;
    this.timeout = null;
    this.previewUrl = null;
    this.handleMessage = this.handleMessage.bind(this);
    window.addEventListener('message', this.handleMessage);
  }

  start() {
    this.iframe.src = `https://www.photopea.com#${encodeURIComponent(JSON.stringify({}))}`;
  }

  destroy() {
    window.removeEventListener('message', this.handleMessage);
    this.clearTimeout();
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
  }

  isBusy() { return this.phase !== 'idle'; }

  async render({ card, artUrl, artKey, crop, mode = 'full' }) {
    if (!this.ready || !this.window) throw new Error('Photopea is still loading.');
    if (!card?.id || !artUrl) throw new Error('Choose artwork before creating a PSD preview.');
    if (this.isBusy()) throw new Error('Photopea is already rendering a preview.');
    const normalizedCrop = { scale: Number(crop.scale), x: Number(crop.pan_x), y: Number(crop.pan_y) };
    const key = `${card.id}|${artKey}`;

    if (this.workCache?.key === key) {
      const request = { ...this.workCache, mode, format: mode === 'interactive' ? 'jpg:0.88' : 'png', mime: mode === 'interactive' ? 'image/jpeg' : 'image/png', initial: false };
      this.workRequest = request;
      this.renderCached(request, normalizedCrop);
      return;
    }

    const request = this.makeRequest(card, key, mode);
    const run = ++this.run;
    this.workRequest = request;
    this.pendingCrop = normalizedCrop;
    this.onStatus('Warming this card’s authentic PSD cache…');
    try {
      const [psd, artResponse] = await Promise.all([this.loadPsd(card), fetch(artUrl, { cache: 'no-store' })]);
      if (!artResponse.ok) throw new Error('Selected artwork is unavailable.');
      this.pendingArt = dataUrlFromBuffer(await artResponse.arrayBuffer(), artResponse.headers.get('content-type') || 'image/jpeg');
      this.pendingPsd = psd;
      if (this.workCache?.docName) {
        this.phase = 'work_cache_cleanup';
        this.send(`(function(){try{var docs=app.documents;for(var i=docs.length-1;i>=0;i--)if(docs[i].name===${JSON.stringify(this.workCache.docName)})docs[i].close(SaveOptions.DONOTSAVECHANGES)}catch(error){app.echoToOE('ARTDESK:DIRECTERR:'+(error&&error.message?error.message:String(error)))}})()`);
        this.armTimeout(run, 20000, 'Photopea did not close the previous work document.');
      } else {
        this.openFresh(run);
      }
    } catch (error) {
      this.fail(error.message || String(error));
    }
  }

  prefetch(card) {
    if (!card?.id || this.prefetched?.id === card.id || this.prefetching) return;
    this.prefetching = fetch(`/psd/${encodeURIComponent(card.id)}`, { cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('Next PSD is unavailable.'); return response.arrayBuffer(); })
      .then(buffer => { this.prefetched = { id: card.id, buffer }; })
      .catch(() => null)
      .finally(() => { this.prefetching = null; });
  }

  cancelPending() {
    if (this.phase === 'idle') return;
    this.run += 1;
    this.phase = 'idle';
    this.workRequest = null;
    this.clearTimeout();
    this.onStatus('Preview cancelled.');
  }

  makeRequest(card, key, mode) {
    const interactive = mode === 'interactive';
    this.workRun += 1;
    return {
      cardId: card.id,
      key,
      docName: `__ART_DESK_WORK_${card.id}_${this.workRun}`,
      mode,
      format: interactive ? 'jpg:0.88' : 'png',
      mime: interactive ? 'image/jpeg' : 'image/png',
      initial: true,
    };
  }

  async loadPsd(card) {
    if (this.prefetched?.id === card.id) {
      const buffer = this.prefetched.buffer;
      this.prefetched = null;
      return buffer.slice(0);
    }
    const response = await fetch(`/psd/${encodeURIComponent(card.id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Authentic card PSD is unavailable.');
    return response.arrayBuffer();
  }

  openFresh(run) {
    if (!this.workRequest || run !== this.run) return;
    this.phase = 'direct_parent_open';
    this.window.postMessage(this.pendingPsd, '*');
    this.armTimeout(run, 60000, 'Photopea did not finish opening the card PSD.');
  }

  renderCached(request, crop) {
    this.phase = 'direct_cached_export';
    this.onStatus(request.mode === 'interactive' ? 'Updating cached authentic-PSD preview…' : 'Rendering cached PSD at full quality…');
    const marker = `${WORK_ART_PREFIX}|`;
    this.send(`(function(){function n(value){return value&&value.value!==undefined?Number(value.value):Number(value)}function findOriginal(layers){for(var i=0;i<layers.length;i++){var layer=layers[i];if(layer.name==='Background'&&layer.kind===LayerKind.SMARTOBJECT)return layer;try{if(layer.layers){var hit=findOriginal(layer.layers);if(hit)return hit}}catch(ignore){}}return null}function findWorkArt(layers){for(var i=0;i<layers.length;i++){var layer=layers[i];if(layer.name&&layer.name.indexOf(${JSON.stringify(marker)})===0)return layer;try{if(layer.layers){var hit=findWorkArt(layer.layers);if(hit)return hit}}catch(ignore){}}return null}try{var doc=null,docs=app.documents;for(var i=0;i<docs.length;i++)if(docs[i].name===${JSON.stringify(request.docName)})doc=docs[i];if(!doc)throw Error('Cached PSD work document is unavailable');var newArt=findWorkArt(doc.layers),oldArt=findOriginal(doc.layers);if(!newArt||!oldArt)throw Error('Cached PSD artwork layer is unavailable');var parts=newArt.name.split('|'),baseWidth=Number(parts[1]),baseHeight=Number(parts[2]),oldBounds=oldArt.bounds,boxWidth=n(oldBounds[2])-n(oldBounds[0]),boxHeight=n(oldBounds[3])-n(oldBounds[1]);if(!(baseWidth>0&&baseHeight>0&&boxWidth>0&&boxHeight>0))throw Error('Cached PSD artwork bounds are invalid');var targetScale=Math.max(boxWidth/baseWidth,boxHeight/baseHeight)*${crop.scale},targetWidth=baseWidth*targetScale,currentBounds=newArt.bounds,currentWidth=n(currentBounds[2])-n(currentBounds[0]);if(!(currentWidth>0&&targetWidth>0))throw Error('Cached artwork dimensions are invalid');newArt.resize(targetWidth/currentWidth*100,targetWidth/currentWidth*100);currentBounds=newArt.bounds;newArt.translate(n(oldBounds[0])+boxWidth/2-(n(currentBounds[0])+(n(currentBounds[2])-n(currentBounds[0]))/2)+${crop.x}/100*boxWidth,n(oldBounds[1])+boxHeight/2-(n(currentBounds[1])+(n(currentBounds[3])-n(currentBounds[1]))/2)+${crop.y}/100*boxHeight);app.activeDocument=doc;doc.saveToOE(${JSON.stringify(request.format)})}catch(error){app.echoToOE('ARTDESK:DIRECTERR:'+(error&&error.message?error.message:String(error)))}})()`);
    this.armTimeout(this.run, 25000, 'The cached PSD update did not finish. The next attempt will rebuild its cache.');
  }

  requestImportedLayer(attempt = 0) {
    if (this.phase !== 'direct_parent_place') return;
    if (attempt > 15) { this.fail('Photopea did not finish placing the selected artwork.'); return; }
    this.importAttempt = attempt;
    this.send(`(function(){try{function injected(layers){for(var i=0;i<layers.length;i++){var layer=layers[i];if(layer.name===${JSON.stringify(IMPORT_MARKER)})return layer;if(layer.kind===LayerKind.SMARTOBJECT&&layer.name!=='upscalemedia-transformed.webp'&&layer.name!=='Background'&&layer.name!=='Logo'&&layer.name.indexOf(${JSON.stringify(WORK_ART_PREFIX)})!==0)return layer;try{if(layer.layers){var hit=injected(layer.layers);if(hit)return hit}}catch(ignore){}}return null}var found=injected(app.activeDocument.layers);if(found)found.name=${JSON.stringify(IMPORT_MARKER)};app.echoToOE(found?'ARTDESK:DIRECTREADY':'ARTDESK:DIRECTWAIT')}catch(error){app.echoToOE('ARTDESK:DIRECTERR:'+(error&&error.message?error.message:String(error)))}})()`);
  }

  exportImportedLayer() {
    const crop = this.pendingCrop;
    const request = this.workRequest;
    this.send(`(function(){function n(value){return value&&value.value!==undefined?Number(value.value):Number(value)}function findByName(layers,name){for(var i=0;i<layers.length;i++){var layer=layers[i];if(layer.name===name)return layer;try{if(layer.layers){var hit=findByName(layer.layers,name);if(hit)return hit}}catch(ignore){}}return null}try{var doc=app.activeDocument,newArt=findByName(doc.layers,${JSON.stringify(IMPORT_MARKER)}),oldArt=findByName(doc.layers,'Background');if(!newArt||!oldArt||newArt===oldArt)throw Error('The real PSD artwork layer was not found');var artBounds=newArt.bounds,oldBounds=oldArt.bounds,artWidth=n(artBounds[2])-n(artBounds[0]),artHeight=n(artBounds[3])-n(artBounds[1]),boxWidth=n(oldBounds[2])-n(oldBounds[0]),boxHeight=n(oldBounds[3])-n(oldBounds[1]);if(!(artWidth>0&&artHeight>0&&boxWidth>0&&boxHeight>0))throw Error('The selected image has invalid bounds');var scale=Math.max(boxWidth/artWidth,boxHeight/artHeight)*${crop.scale}*100;newArt.resize(scale,scale);artBounds=newArt.bounds;newArt.translate(n(oldBounds[0])+boxWidth/2-(n(artBounds[0])+(n(artBounds[2])-n(artBounds[0]))/2)+${crop.x}/100*boxWidth,n(oldBounds[1])+boxHeight/2-(n(artBounds[1])+(n(artBounds[3])-n(artBounds[1]))/2)+${crop.y}/100*boxHeight);newArt.move(oldArt,ElementPlacement.PLACEBEFORE);newArt.grouped=true;oldArt.visible=false;newArt.name=${JSON.stringify(WORK_ART_PREFIX)}+'|'+artWidth+'|'+artHeight;doc.name=${JSON.stringify(request.docName)};doc.saveToOE(${JSON.stringify(request.format)})}catch(error){app.echoToOE('ARTDESK:DIRECTERR:'+(error&&error.message?error.message:String(error)))}})()`);
  }

  handleMessage(event) {
    if (!this.window && event.data === 'done' && event.source === this.iframe.contentWindow) {
      this.window = event.source;
      this.ready = true;
      this.onReady(true);
      return;
    }
    if (event.source !== this.window) return;

    if (typeof event.data === 'string' && event.data.startsWith('ARTDESK:DIRECTERR:')) {
      this.fail(event.data.slice('ARTDESK:DIRECTERR:'.length));
      return;
    }
    if (event.data instanceof ArrayBuffer && ['direct_parent_export', 'direct_cached_export'].includes(this.phase)) {
      this.finish(event.data, this.phase === 'direct_cached_export');
      return;
    }
    if (event.data === 'done' && this.phase === 'work_cache_cleanup') {
      this.workCache = null;
      this.openFresh(this.run);
      return;
    }
    if (event.data === 'done' && this.phase === 'direct_parent_open') {
      this.phase = 'direct_parent_place';
      this.onStatus('Installing selected artwork at the PSD background-layer position…');
      this.send(`try{app.open(${JSON.stringify(this.pendingArt)},'',true)}catch(error){app.echoToOE('ARTDESK:DIRECTERR:'+(error&&error.message?error.message:String(error)))}`);
      setTimeout(() => this.requestImportedLayer(0), 1200);
      return;
    }
    if (event.data === 'ARTDESK:DIRECTWAIT' && this.phase === 'direct_parent_place') {
      setTimeout(() => this.requestImportedLayer((this.importAttempt || 0) + 1), 1600);
      return;
    }
    if (event.data === 'ARTDESK:DIRECTREADY' && this.phase === 'direct_parent_place') {
      this.phase = 'direct_parent_export';
      this.onStatus('Rendering the authentic PSD layer stack…');
      this.exportImportedLayer();
    }
  }

  finish(buffer, fromCache) {
    const request = this.workRequest || { mode: 'full', mime: 'image/png' };
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = URL.createObjectURL(new Blob([buffer], { type: request.mime }));
    if (request.initial) this.workCache = { key: request.key, docName: request.docName, cardId: request.cardId };
    this.phase = 'idle';
    this.workRequest = null;
    this.clearTimeout();
    this.onPreview(this.previewUrl, { mode: request.mode, fromCache });
    this.onStatus(request.mode === 'interactive'
      ? (fromCache ? 'Fast authentic-PSD preview — cached card reused.' : 'Authentic PSD cached — slider previews are now faster.')
      : 'Exact authentic-PSD preview rendered at full quality.');
  }

  fail(message) {
    if (this.phase === 'direct_cached_export') this.workCache = null;
    this.phase = 'idle';
    this.workRequest = null;
    this.clearTimeout();
    this.onError(message);
  }

  send(script) {
    if (!this.window) throw new Error('Photopea is not ready.');
    this.window.postMessage(script, '*');
  }

  armTimeout(run, milliseconds, message) {
    this.clearTimeout();
    this.timeout = setTimeout(() => { if (run === this.run && this.phase !== 'idle') this.fail(message); }, milliseconds);
  }

  clearTimeout() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
  }
}

function dataUrlFromBuffer(buffer, mime) {
  let text = '';
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mime};base64,${btoa(text)}`;
}
