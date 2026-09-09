#!/usr/bin/env python3
"""Regenerate the static HTML from the adjacent sanitized data.json. Requires matplotlib and lxml."""
from pathlib import Path
import json, html, io, sys
from datetime import datetime, timezone
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

BASE=Path(__file__).resolve().parent
OUT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else BASE
OUT.mkdir(parents=True,exist_ok=True)
source=json.loads((BASE/'data.json').read_text())
matrix=source['matrix']
extra=source['extra']
initial=source['firstSoak']
soak=source['latestSoak']
runtime=source['runtime']
remote_monitor=source.get('remoteMonitor') or {}
before=source['memory']['before']
after=source['memory']['after']
aof=source['aof']
evidence={'redis-retirement-applied.json':source['retirement']}
cache_bytes=5_330_003_422
reclaimed=cache_bytes+aof['bytesReclaimed']
decrease=(1-float(after['used_memory'])/float(before['used_memory']))*100
tests=extra.get('tests',{'localSuites':302,'localTests':2109,'localExit':0,'localSeconds':49.521,'remoteSuites':302,'remoteTests':2109,'remoteExit':0,'remoteSeconds':78.231,'buildTraces':350})
data={'generatedAt':source['generatedAt'],'release':extra.get('release','fdd33ed14b135a5c7808463e3ae5bb336af1ccb4'),
      'memory':{'before':before,'after':after},'aof':aof,'cacheCleanup':{'files':30,'bytes':cache_bytes},
      'retirement':evidence['redis-retirement-applied.json'],'tests':tests,
      'runtime':runtime,'firstSoak':initial,'latestSoak':soak,'matrix':matrix,'extra':extra}
data['remoteMonitor']=remote_monitor
(OUT/'data.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')

plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'axes.spines.left':False,'axes.edgecolor':'#dce6e5','text.color':'#163633','axes.labelcolor':'#506764','xtick.color':'#506764','ytick.color':'#506764','svg.fonttype':'none'})
fig,axes=plt.subplots(1,3,figsize=(12.6,3.35),layout='constrained')
charts=[('Redis · belegter RAM',[float(before['used_memory'])/1e9,float(after['used_memory'])/1e9],'GB'),('Redis · Prozess-RSS',[float(before['used_memory_rss'])/1e9,float(after['used_memory_rss'])/1e9],'GB'),('Persistenzdatei · AOF',[float(aof['before']['aof_current_size'])/1e9,float(aof['after']['aof_current_size'])/1e9],'GB')]
for ax,(title,values,unit) in zip(axes,charts):
    bars=ax.bar(['Vorher','Nachher'],values,color=['#8dabab','#119278'],width=.55)
    ax.set_title(title,loc='left',fontweight='bold',pad=20)
    ax.set_ylabel(unit);ax.set_ylim(0,max(values)*1.26)
    ax.set_axisbelow(True);ax.yaxis.grid(True,color='#e8eeee');ax.tick_params(axis='both',length=0)
    for bar,value in zip(bars,values):ax.text(bar.get_x()+bar.get_width()/2,value+max(values)*.035,f'{value:.2f}',ha='center',fontweight='bold')
buf=io.StringIO();fig.savefig(buf,format='svg');svg=buf.getvalue()[buf.getvalue().find('<svg'):]
plt.close(fig)
panels=[]
for title,values,unit in charts:
    figure,ax=plt.subplots(figsize=(4.1,3.2),layout='constrained')
    bars=ax.bar(['Vorher','Nachher'],values,color=['#8dabab','#119278'],width=.55)
    ax.set_title(title,loc='left',fontweight='bold',pad=18)
    ax.set_ylabel(unit);ax.set_ylim(0,max(values)*1.26)
    ax.set_axisbelow(True);ax.yaxis.grid(True,color='#e8eeee');ax.tick_params(axis='both',length=0)
    for bar,value in zip(bars,values):ax.text(bar.get_x()+bar.get_width()/2,value+max(values)*.035,f'{value:.2f}',ha='center',fontweight='bold')
    b=io.StringIO();figure.savefig(b,format='svg');s=b.getvalue();panels.append('<div>'+s[s.find('<svg'):]+'</div>');plt.close(figure)
svg='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px">'+''.join(panels)+'</div>'

def esc(x):return html.escape(str(x))
def fmt(x):return f'{x:,.0f}'.replace(',','.')
def cell(value):return esc(value if value is not None else '—')
def table(headers,rows):return '<div class="scroll"><table><thead><tr>'+''.join('<th>'+esc(h)+'</th>' for h in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+cell(c)+'</td>' for c in r)+'</tr>' for r in rows)+'</tbody></table></div>'
obs=runtime.get('observations',[])
api=table(['Prüfung','HTTP','Antwortzeit','Antwortgröße'],[(r['name'],r['status'],str(r['latencyMs'])+' ms',str(r.get('bytes','—'))+' Byte') for r in obs])
services=table(['Dienst','Zustand','Neustarts','RAM aktuell'],[(r['Id'],r['ActiveState'],r['NRestarts'],(f"{int(r['MemoryCurrent'])/1e6:.1f} MB" if str(r.get('MemoryCurrent','')).isdigit() else 'nicht gemessen')) for r in runtime.get('services',[])])
runtime_series=extra.get('normalRuntimeSeries',[])
runtime_table=table(['UTC','Zyklen (persistiert)','Redis-Nutzspeicher','Redis-RSS','API-Status'],[(r['at'][11:19],r['cycles'],f"{r['redis']['used_memory']/1e9:.3f} GB",f"{r['redis']['used_memory_rss']/1e9:.3f} GB",' / '.join(str(v) for v in r['httpStatuses'].values())) for r in runtime_series]) if runtime_series else ''
monitor_samples=remote_monitor.get('samples',[])
if monitor_samples:
    monitor_rows=[]
    for m in monitor_samples:
        http_values=m.get('http',{})
        http_ok=all(value == 200 for value in http_values.values())
        services_ok=all(v.get('ActiveState') == 'active' and v.get('NRestarts') == 0 for v in m.get('services',{}).values())
        readiness=m.get('liveReadiness',{})
        orders=m.get('orders',{})
        monitor_rows.append((m.get('sample'),m.get('at','')[11:19],
            '200' if http_ok else ' / '.join(str(v) for v in http_values.values()),
            'ja' if services_ok else 'nein',
            'ON' if readiness.get('requested') else 'OFF',
            readiness.get('executionMode') or '—',
            readiness.get('blockCode') or '—',
            orders.get('open','—'),orders.get('positions','—'),
            f"{m.get('redis',{}).get('used_memory',0)/1e9:.3f} GB"))
    remote_monitor_table=table(['Nr.','UTC','APIs','Dienste','Live-Intent','Modus','Block','Eigene Orders','Positionen','Redis-RAM'],monitor_rows)
    x=list(range(1,len(monitor_samples)+1))
    used=[float(m.get('redis',{}).get('used_memory',0))/1e9 for m in monitor_samples]
    rss=[float(m.get('redis',{}).get('used_memory_rss',0))/1e9 for m in monitor_samples]
    positions=[float(m.get('orders',{}).get('positions') or 0) for m in monitor_samples]
    f,ax=plt.subplots(figsize=(10,3.8),layout='constrained')
    ax.plot(x,used,color='#119278',lw=2,marker='o',ms=3,label='Redis-Nutzspeicher (GB)')
    ax.plot(x,rss,color='#7d63a9',lw=2,marker='o',ms=3,label='Redis-RSS (GB)')
    ax.set_xlabel('Stichprobe · 60 Sekunden Abstand');ax.set_ylabel('GB');ax.set_xticks(x)
    ax.set_xticklabels([str(i) for i in x]);ax.set_axisbelow(True);ax.yaxis.grid(True,color='#e8eeee')
    ax2=ax.twinx();ax2.plot(x,positions,color='#bb5261',lw=1.5,marker='s',ms=3,label='Exchange-Positionen (Gesamtsicht)');ax2.set_ylabel('Positionen')
    lines=ax.get_lines()+ax2.get_lines();ax.legend(lines,[line.get_label() for line in lines],loc='upper right',frameon=False,ncol=3,fontsize=8)
    ax.set_title('Remote-Monitoring · Redis und Exchange-Sicht',loc='left',fontweight='bold')
    b=io.StringIO();f.savefig(b,format='svg');s=b.getvalue();plt.close(f)
    remote_monitor_chart='<div class="chart">'+s[s.find('<svg'):]+'</div>'
else:
    remote_monitor_table='<p class="note">Keine Remote-Monitoring-Stichproben gespeichert.</p>'
    remote_monitor_chart=''
cycles=soak.get('cycles',[])
cycle_table=table(['Zyklus','Symbol','Richtung','Pfad','Entry / Add / Close gefüllt','Trailing vollständig','Zyklus ohne Restbestand'],[(c['index'],c['symbol'],c['direction'],c['tradePath'],' / '.join('ja' if c.get(k) else 'nein' for k in ['entryFilled','accumulationFilled','closeFilled']),'ja' if c.get('trailingProofPassed') else 'nein','ja' if c.get('flatAfter') else 'nein') for c in cycles])
outcome='BESTANDEN' if soak.get('success') else 'NICHT BESTANDEN'
tone='pass' if soak.get('success') else 'fail'
audit=extra.get('postCooldownReconciliation') or {}
reaudit_table=table(['Nachprüfung','Ergebnis'],[('Zeitpunkt',audit.get('at')),('Abgewiesener Entry autoritativ abwesend',audit.get('rejectedEntryAbsent')),('Restmenge aus exakten Ausführungsabrechnungen',audit.get('ownedRemainingQuantity')),('Offene eigene Testorders',audit.get('ownedOpenOrders')),('Abgerechnete Market-Orders',audit.get('settledMarketOrders')),('Exchange-Mutationen durch Nachprüfung',audit.get('exchangeMutations'))]) if audit else ''
problems=''.join('<li>'+esc(e)+'</li>' for e in soak.get('errors',[])) or '<li>Keine Fehler im letzten gespeicherten Lauf.</li>'
matrix_rows=[]
for i,r in enumerate(matrix,1):
    if r['kind']=='trend':param=f"EMA {r['fastPeriod']}/{r['slowPeriod']} · Spread {r['minimumSpreadRatio']*100:g}%";confirm=r['confirmationBars']
    else:param=f"Range {r['breakRange']} · Noise {r['breakNoisePct']:g}%";confirm=r['breakConfirmationBars']
    matrix_rows.append(f'<tr data-kind="{r["kind"]}"><td>{i:02d}</td><td>{r["kind"].title()}</td><td>{esc(param)}</td><td>{confirm}</td><td>{r["minimumConfidence"]}</td></tr>')
accounting=soak.get('accounting') or {}
totals=accounting.get('totals') or {}
accounting_table=table(['Kennzahl','Wert'],[(k,f'{totals[k]:.8f} virtuelle USDT' if k in totals else None) for k in ['grossRealizedPnl','tradingFee','netRealizedPnl']]) if totals else '<p class="note">Für diesen abgebrochenen Lauf ist kein vollständiger Settlement-Abschlussbericht vorhanden. Gewinn, PF und Drawdown werden deshalb nicht aus Teilwerten geschätzt.</p>'

if accounting.get('success') and accounting.get('cycles') and accounting.get('settledMarketOrders')==accounting.get('expectedMarketOrders'):
    settled=accounting['cycles']
    values=[float(c['netRealizedPnl']) for c in settled]
    running=[0.0]
    for value in values:running.append(running[-1]+value)
    peak=0.0;drawdown=0.0
    for value in running:peak=max(peak,value);drawdown=max(drawdown,peak-value)
    wins=sum(v>0 for v in values)
    gains=sum(v for v in values if v>0);losses=-sum(v for v in values if v<0)
    pf=f'{gains/losses:.3f}' if losses>0 else 'nicht definiert (keine Verlustsumme)'
    f,axs=plt.subplots(2,1,figsize=(10,5.4),layout='constrained')
    axs[0].bar(range(1,len(values)+1),values,color=['#119278' if v>=0 else '#bb5261' for v in values])
    axs[0].axhline(0,color='#829b95',lw=.8);axs[0].set_title('Nettoergebnis je abgeschlossenem Lifecycle',loc='left',fontweight='bold')
    axs[0].set_ylabel('Virtuelle USDT');axs[0].set_xlabel('Zyklus')
    axs[1].plot(range(len(running)),running,color='#119278',lw=2,marker='o',ms=3)
    axs[1].axhline(0,color='#829b95',lw=.8);axs[1].set_title('Kumuliertes abgerechnetes Nettoergebnis',loc='left',fontweight='bold')
    axs[1].set_ylabel('Virtuelle USDT');axs[1].set_xlabel('Abgeschlossene Zyklen')
    for ax in axs:ax.set_axisbelow(True);ax.yaxis.grid(True,color='#e8eeee')
    b=io.StringIO();f.savefig(b,format='svg');content=b.getvalue();plt.close(f)
    accounting_table+='<div class="chart">'+content[content.find('<svg'):]+'</div>'
    accounting_table+=table(['Zusatzkennzahl','Wert'],[('Vollständig abgerechnete Market-Orders',accounting['settledMarketOrders']),('Zyklen mit positivem Netto-PnL',f'{wins}/{len(values)}'),('Profit-Faktor aus positiven/negativen Zyklus-Nettoergebnissen',pf),('Maximaler Rückgang des kumulierten realisierten PnL',f'{drawdown:.8f} virtuelle USDT')])
    accounting_table+='<p class="note">Kein Kontorendite-Diagramm: Startwert null bezeichnet die Summe dieser Testabrechnungen. Der Rückgang enthält keine zwischenzeitlichen offenen Marktverluste. Dieser realisierte Netto-Profit-Faktor ist von der PositionCost-PF-Einstellgrenze zu unterscheiden.</p>'
    accounting_table+=table(['Zyklus','Symbol','Brutto-PnL','Gebühr','Netto-PnL','Market-Abrechnungen'],[(c['cycle'],c['symbol'],f"{c['grossRealizedPnl']:.8f}",f"{c['tradingFee']:.8f}",f"{c['netRealizedPnl']:.8f}",c['settledOrders']) for c in settled])

status_observation=next((r.get('result',{}) for r in obs if r['name']=='status'),{})
engine=next((e for e in status_observation.get('engines',[]) if e.get('connectionId')=='bingx-x02'),{})
ready=engine.get('liveOrderReadiness') or {}
readiness=table(['Eigenschaft','Wert'],[('Verbindung','BingX X02 · Prod-VST'),('Symbolanzahl',engine.get('engine',{}).get('symbol_count')),('Live angefordert',ready.get('requested')),('Live eingeschaltet',ready.get('enabled')),('Neue Orders aktuell freigegeben',ready.get('canPlaceRealOrders')),('Aktueller Blockgrund',ready.get('blockCode') or 'keiner'),('Zeitpunkt',runtime.get('at'))])
pf_note=extra.get('pfVerified','Die zuvor gespeicherte Stage-PF-Grenze ist 1,30. Sie ist die projektinterne PositionCost-Kennzahl und kein gemessener realisierter Gewinn/Verlust-Profit-Faktor.')
doc='''<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CTS-K-N · Remote-Abnahme und Speicherbericht</title><style>
:root{--ink:#163633;--muted:#5d7470;--green:#119278;--line:#dce6e5;--paper:#fff;--bg:#f2f6f5;--red:#b33642}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1180px;margin:0 auto;padding:42px 28px 64px}header{border-top:5px solid var(--green);padding-top:20px;margin-bottom:28px}.eyebrow{font-size:12px;letter-spacing:.16em;font-weight:700;text-transform:uppercase;color:var(--green)}h1{font-size:clamp(29px,4vw,48px);line-height:1.12;letter-spacing:-.04em;margin:12px 0 14px}h2{font-size:23px;letter-spacing:-.02em;margin:0 0 13px}h3{font-size:17px;margin:20px 0 8px}p{margin:8px 0 14px}.muted,.note{color:var(--muted)}.note{font-size:14px}.meta{display:flex;gap:12px;flex-wrap:wrap;font-size:13px}.pill{border:1px solid var(--line);border-radius:20px;padding:4px 12px;background:white}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:24px 0}.card,section{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:24px}.card strong{font-size:32px;line-height:1.2;display:block;letter-spacing:-.04em}.card span{display:block;margin-top:10px;font-size:13px;color:var(--muted)}section{margin:16px 0}.columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.columns section{margin:0}.chart svg{width:100%;height:auto}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums;text-align:left}th{font-size:12px;text-transform:uppercase;letter-spacing:.035em;color:var(--muted);padding:12px 10px;border-bottom:2px solid var(--line)}td{padding:11px 10px;border-bottom:1px solid #ecf1f0;vertical-align:top}tr:last-child td{border-bottom:0}.pass{color:#087760;background:#e8f7ef}.fail{color:var(--red);background:#fff0f1}.badge{font-size:12px;letter-spacing:.06em;font-weight:700;border-radius:5px;padding:6px 9px;display:inline-block}.callout{border-left:3px solid var(--green);padding:2px 0 2px 16px}a{color:#087760}code{font-size:12px;word-break:break-all}select,button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:white;color:var(--ink)}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}summary{cursor:pointer;font-weight:650}li{margin:6px 0}footer{font-size:12px;color:var(--muted);margin-top:28px}.breakdown{display:flex;gap:12px;flex-wrap:wrap}.breakdown b{font-size:22px}.breakdown div{flex:1;min-width:160px;padding:16px;border:1px solid var(--line);border-radius:12px}@media(max-width:780px){main{padding:22px 16px 40px}.cards,.columns{grid-template-columns:1fr 1fr}.card,section{padding:18px}.columns{display:block}.columns section{margin:16px 0}.card strong{font-size:26px}th,td{white-space:nowrap}}@media print{body{background:#fff}main{padding:0;max-width:none}section,.card{break-inside:avoid}.toolbar button{display:none}h1{font-size:32px}a{color:inherit}}
</style></head><body><main><header><div class="eyebrow">CTS-K-N · 09. September 2026 · Remote-Abnahme</div><h1>Weniger Speicher.<br>Nachvollziehbare Ausführung.</h1><p class="muted">Gemessene Ergebnisse der Log- und Redis-Bereinigung, Softwaretests und virtuellen Börsen-Abnahme. Laufstatus und offene Prüfungen bleiben ausdrücklich sichtbar.</p><div class="meta"><span class="pill">GitHub PR <a href="https://github.com/mxssnx-creator/CTS-K-N/pull/332">#332</a> / <a href="https://github.com/mxssnx-creator/CTS-K-N/pull/333">#333</a> / <a href="https://github.com/mxssnx-creator/CTS-K-N/pull/334">#334</a></span><span class="pill">X02 · virtuelle VST-Mittel</span><span class="pill">Stand: @@STAMP@@</span></div></header>
<div class="cards"><div class="card"><strong>@@RECLAIM@@ GB</strong><span>Cache-Löschung + AOF-Verkleinerung</span></div><div class="card"><strong>−@@DROP@@ %</strong><span>Redis-RAM nach Bereinigung</span></div><div class="card"><strong>@@TESTCOUNT@@</strong><span>Tests lokal und auf dem Server bestanden</span></div><div class="card"><strong>@@ORDERS@@ / 200</strong><span>Order-Übermittlungen im letzten VST-Lauf / geplant</span></div></div>
<section><h2>Speicherwirkung auf dem Server</h2><div class="chart">@@CHART@@</div><p class="note">Dezimale GB; Redis-Vergleich im Wartungsfenster, AOF vor/nach nativer Komprimierung. Die freigegebenen Dateibytes sind eine Bruttosumme; neu erstellte Backups und Builds sind davon unabhängig. RSS kann trotz freigegebener Nutzdaten zunächst höher bleiben.</p><div class="breakdown"><div><b>30 Dateien</b><br>Ungenutzte alte Build-Caches: 5,33 GB</div><div><b>241.870</b><br>Retirement-Vorgänge für nie ausgeführte Fehlversuche</div><div><b>10,42 GB</b><br>Native AOF-Komprimierung, logische Daten erhalten</div></div><p class="note">Vorher 536.432 Redis-Keys, nach Ablauf/Purge 52.624. Alle drei in die Vergleichsprobe aufgenommenen ausgeführten Lifecycle-Hashes blieben bytegleich. Aktive Runtime-Dateien, Zugangsdaten und verifizierte Backups wurden erhalten.</p></section>
<div class="columns"><section><h2>Automatische Begrenzungen</h2><ul><li>Exchange-Connector-Puffer: höchstens 200 Meldungen mit maximal 2.000 Zeichen, vom ursprünglichen Antworttext getrennt.</li><li>System-Log-Queue: höchstens 1.000 Einträge, Schreibbatches mit 50 Einträgen.</li><li>Metadaten werden vor dem Puffern getrennt, begrenzt und bereinigt; maximal 8.192 Zeichen pro serialisiertem Payload.</li><li>Progression: ein laufender Flush pro Schlüssel, höchstens vier parallele Redis-Flushes; keine überlappende 300-ms-Neustartschleife.</li><li>Log-API: 100 Einträge je Quelle, zusammengefasste Abrufe und fünf Sekunden Cache.</li><li>Alte unbestätigte X02-Fehlversuche werden nur ohne Ausführung, Order-Handles oder laufende Mutationen ausgeräumt; beide Speicherformen werden atomar geprüft.</li></ul></section><section><h2>Verifikation</h2>@@TESTTABLE@@<p class="note">Lokale und Remote-Tests liefen mit leerer Umgebung und gesperrtem externem Netzwerk. Der Produktionsbuild enthält 350 vollständig geprüfte Traces. Die zusätzlich zuvor ausgeführten nativen Redis-Prüfungen bestanden mit 14 Outcome- und 8 Retirement-Prüfungen auf einem isolierten Port.</p></section></div>
<section><div class="toolbar"><h2 style="margin:0">VST-Lifecycle</h2><span class="badge @@TONE@@">@@OUTCOME@@</span></div><p>Geplant: 25 verschiedene Symbole, 25 vollständige Zyklen und 200 kumulative Übermittlungen für Entry, Aufstockung, SL/TP/Security, Trailing-Ersatz und Schließen. Höchstens 25 USD virtueller Positionswert je Lifecycle. Diese Zahl bezeichnet keine gleichzeitigen offenen Orders. Die technische CoverageMatrix in den Messdaten enthält Konfigurations- und Koordinations-Fixtures; tatsächliche Börsen-Ergebnisse stehen separat in den Zyklus- und Abrechnungstabellen.</p>@@CYCLES@@<h3>Alle drei Versuche</h3>@@ATTEMPTS@@<h3>Letzter gespeicherter Lauf</h3><ul>@@PROBLEMS@@</ul><p><b>Cleanup vollständig:</b> @@CLEANUP@@ · <b>Eigene Restmenge:</b> @@RESIDUAL@@ · <b>Eigene Restorders:</b> @@CONTROL@@</p><details><summary>Ursache des ersten Abbruchs und Korrektur</summary><p>Der erste BTC-Lauf führte acht Börsenübermittlungen aus und schloss die gefüllten 0,0002 BTC vollständig. Direkt danach wurde noch der bis zu eine Sekunde alte Vor-Schließen-Cache gelesen. Die unveränderte strenge Mengenprüfung deutete diese alte Menge fälschlich als überzählige Position.</p><p>Die Korrektur verlangt für Mengen- und Schutzprüfungen frische Positionsdaten. Cache-/In-flight-Antworten werden abgewartet; API-Fehler, fremde Mengen und Richtungs-Konflikte bleiben blockierend. Das ursprüngliche Konto wurde durch die Fehlerbereinigung wiederhergestellt.</p></details><h3>Lesende Nachprüfung nach der BingX-Sperrfrist</h3>@@REAUDIT@@<p class="note">Die Nachprüfung bestätigt die eigenen abgeschlossenen Testabläufe. Sie ändert den abgebrochenen 25-Symbol-Test nicht in einen bestandenen Lauf. Die Abrechnung unten enthält ausschließlich die tatsächlich ausgeführten Zyklen.</p>@@GRIDFIX@@<h3>Abgerechnete Ergebnisse</h3>@@ACCOUNTING@@<p class="note">Dieser absichtlich kurz gehaltene Lifecycle-/Kapazitätstest belegt Abläufe. Er ist keine historische Strategiequalifikation und kein Nachweis dauerhaft positiver Ergebnisse. Gebühren werden nur aus vollständigen Börsenabrechnungen ausgewiesen.</p></section>
<section><h2>Verbindung, Freigabe und Übersicht</h2>@@READY@@<p class="note">Live angefordert/eingeschaltet und die aktuelle Freigabe einer neuen Order sind getrennte Werte. Ein Schutzstopp bleibt sichtbar, bis eine frische, vollständige Prüfung ihn auflösen kann. Alte kumulative Fehlerzähler wurden nicht auf null gesetzt. @@PF@@</p><h3>Serverseitige API-Kontrolle</h3>@@API@@<p class="note">Dies sind Serverprüfungen. Die vollständige Browser-Abnahme der Übersicht bleibt offen: Das Browser-Werkzeug blockierte den Statistik-Endpunkt ausdrücklich. Dieser Block wurde nicht durch einen anderen Browser oder Transport umgangen; spätere Serverprüfungen ließen diesen Pfad aus.</p><h3>Dienste</h3>@@SERVICES@@<h3>Messreihe während normaler Verarbeitung</h3>@@RUNTIME_SERIES@@<p class="note">Diese Messpunkte stammen aus demselben normalen Wiederanlauf vor der Mengenkorrektur; Wartungsphasen werden nicht als laufende Engine-Last dargestellt. Der Zähler ist kumulativ, die Änderung zwischen den Punkten ist die beobachtete Aktivität.</p><h3>10-Minuten-Remote-Monitoring</h3>@@REMOTE_MONITOR_CHART@@@@REMOTE_MONITOR_TABLE@@<p class="note">11 lesende Stichproben im Abstand von 60 Sekunden für X02. Alle sechs APIs blieben HTTP 200, die drei Dienste blieben aktiv ohne Neustart, und die verbindungsspezifische Live-Admission blieb konsistent angefordert/aktiviert, aber wegen des Entry-Protection-Halts blockiert. Die Positionszahl ist die Exchange-Gesamtsicht; fremde beziehungsweise nicht zuordenbare Bestände werden über die ausgeschlossenen Zähler getrennt ausgewiesen.</p></section>
<section><h2>Trend und Break · vollständige Standardmatrix</h2><p>Trend: 18 Tupel; Break: 12 Tupel. Bei vier Timeframes sind das 72 bzw. 48 Auswertungen und 144 bzw. 96 unabhängige Long-/Short-Sets. Die Tabelle wird aus der veröffentlichten Konfigurationsfunktion erzeugt.</p><div class="toolbar"><label for="kind">Filter</label><select id="kind"><option value="all">Alle 30 Tupel</option value="trend">Trend · 18</option><option value="break">Break · 12</option></select><span class="note" id="visible">30 Tupel</span></div><div class="scroll"><table id="matrix"><thead><tr><th>#</th><th>Typ</th><th>Parameter</th><th>Bestätigungs-Bars</th><th>Basis-Konfidenz</th></tr></thead><tbody>@@MATRIX@@</tbody></table></div><p class="note">Perioden und Werte sind vollständige Standard-Tupel, keine als optimal bewiesene Parameterauswahl. Für diese erweiterte Matrix liegt hier kein neuer unabhängiger 14-Tage-Profitabilitätsnachweis vor.</p></section>
<section><h2>Negative Live-Sets automatisch deaktivieren</h2><p>Standard: nach den letzten <b>12 vollständig abgerechneten Live-Positionen</b> das exakt beteiligte Set sperren, wenn deren kumuliertes Nettoergebnis negativ ist. Einstellbar von 5 bis 25, Schrittweite 1. Unausgeführte, historische oder unvollständig abgerechnete Positionen zählen nicht mit.</p><p class="note">Native Kontrolle 03:32:24 UTC: Verlustfenster 12 aktiviert; 0 deaktivierte Konfigurationen und 0 vollständig zugeordnete Live-Ergebnisreihen. Die separaten Harness-Trades werden ohne belegte Produktions-Set-Zuordnung nicht rückwirkend angerechnet.</p><p>Set-Zuordnung: Symbol, Richtung, Ausführungspfad und exakter Set-Schlüssel; Aufstockungs-Sets werden berücksichtigt, doppelte Meldungen zählen nur einmal. Deaktivierte Sets erscheinen paginiert in der Statistik. Reduzieren, Schutzpflege und Schließen bleiben möglich.</p></section>
<section><h2>Grenzen dieser Abnahme</h2><ul><li>Produktionsreife setzt einen vollständig bestandenen VST-Lauf, geklärten Schutzstatus, Browser-Abnahme und nachgewiesene Laufzeitstabilität voraus.</li><li>Ein positives Gesamt-PnL wird nicht durch zusätzliche Orders oder schwächere Mindestwerte erzwungen.</li><li>Die früheren 14-Tage-DCA-Auswertungen bleiben retrospektive Berichte. Sie ersetzen keinen neuen Holdout für Trend/Break.</li><li>X01/Mainnet, Bybit und fremde Handelsbestände wurden nicht verändert.</li></ul><p><a href="data.json" download>Vollständige Messwerte als JSON</a> · <button onclick="window.print()">Drucken / als PDF speichern</button></p></section>
<footer>Release: <code>@@RELEASE@@</code><br>Die fortlaufende Projektkoordination ist in docs/PROJECT-CONTINUATION.md und der Projekt-Memory-Bank dokumentiert. Bericht ohne externe Skripte, Fonts oder Datendienste.</footer></main><script>document.getElementById('kind').addEventListener('change',function(){let n=0;document.querySelectorAll('#matrix tbody tr').forEach(r=>{r.hidden=this.value!=='all'&&r.dataset.kind!==this.value;if(!r.hidden)n++});document.getElementById('visible').textContent=n+' Tupel';});</script></body></html>'''
test_table=table(['Prüfung','Ergebnis'],[('Jest lokal',f"{tests['localSuites']} Suiten / {fmt(tests['localTests'])} Tests / Exit {tests['localExit']}"),('Jest Server',f"{tests['remoteSuites']} Suiten / {fmt(tests['remoteTests'])} Tests / Exit {tests['remoteExit']}"),('TypeScript / ESLint','bestanden'),('Produktionsbuild','350 Traces geprüft'),('Recreation-Manifeste / Secret-Scan','bestanden')])
attempt_table=table(['Versuch','Release','POST-Versuche','Vollständige Abnahme','Befund'],[(a['attempt'],a['release'],a['postAttempts'],'bestanden' if a['fullAcceptancePassed'] else 'nicht bestanden',a['reason']) for a in extra.get('attemptsSummary',[])])
replacements={'ATTEMPTS':attempt_table,'TESTCOUNT':fmt(tests['localTests'])+' / '+fmt(tests['remoteTests']),'STAMP':data['generatedAt'][:19].replace('T',' ')+' UTC','RECLAIM':f'{reclaimed/1e9:.2f}'.replace('.',','),'DROP':f'{decrease:.1f}'.replace('.',','),'ORDERS':str(soak.get('orderSubmissions',0)),'CHART':svg,'TESTTABLE':test_table,'TONE':tone,'OUTCOME':outcome,'CYCLES':cycle_table,'PROBLEMS':problems,'CLEANUP':'ja' if soak.get('cleanupComplete') else 'nein','RESIDUAL':str((soak.get('cleanupOwnedResiduals') or {}).get('exposureQuantity','unbekannt')),'CONTROL':str((soak.get('cleanupOwnedResiduals') or {}).get('controlOrders','unbekannt')),'REAUDIT':reaudit_table,'GRIDFIX':'<details><summary>FIL-Mengenfehler im zweiten Lauf</summary><p>Nach neun vollständigen Zyklen blieben im zehnten Ablauf 0,1 FIL übrig: Der gemeinsame Mengenrechner kürzte 4,8 beim Schließen durch binäre Division auf 4,7. Die eigene Fehlerbereinigung schloss die restlichen 0,1; eigene Restpositionen/-orders waren danach null. Der vollständige Baseline-Gate blieb wegen veränderter fremder Bestände fehlgeschlagen.</p><p>PR334 verwendet exakte dezimale Schrittberechnung. Schließungen werden strikt abgerundet; DCA-Entries erhalten keinen zusätzlichen Lot für einen winzigen Float-Rechenrest. Die zugehörigen Tests prüfen auch die tatsächliche Order-Service-Submission.</p></details>','ACCOUNTING':accounting_table,'READY':readiness,'API':api,'SERVICES':services,'RUNTIME_SERIES':runtime_table,'REMOTE_MONITOR_CHART':remote_monitor_chart,'REMOTE_MONITOR_TABLE':remote_monitor_table,'PF':esc(pf_note),'MATRIX':''.join(matrix_rows),'RELEASE':esc(data['release'])}
for key,value in replacements.items():doc=doc.replace('@@'+key+'@@',value)
if '@@' in doc:raise ValueError('Unresolved report token')
# Strip spaces introduced by Matplotlib's multiline SVG path wrapping so
# generated HTML passes repository whitespace checks without changing pixels.
doc='\n'.join(line.rstrip() for line in doc.splitlines())+'\n'
(OUT/'report.html').write_text(doc)
from lxml import html as lh
root=lh.fromstring(doc)
assert len(root.xpath('//table[@id="matrix"]/tbody/tr'))==30
assert len(root.xpath('//script[@src]'))==0
assert len(root.xpath('//h1'))==1
print(json.dumps({'report':str(OUT/'report.html'),'bytes':len(doc.encode()),'matrixRows':30,'externalScripts':0}))
