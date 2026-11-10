const PDFDocument = require('pdfkit');
const path = require('path');
module.exports = (data) => new Promise((resolve, reject) => {
  const doc = new PDFDocument({size:'A4',margin:24});
  const chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
  const left=24, width=547, gap=12, half=(width-gap)/2;
  const label=(text,x,y)=>doc.font('Helvetica-Bold').fontSize(9).fillColor('#111111').text(text,x,y,{width:width,lineBreak:false});
  const value=v=>String(v ?? '');
  const field=(title,v,x,y,w,min=28,fill='#ffffff')=>{
    label(title,x,y);doc.font('Helvetica').fontSize(10);
    const h=Math.max(min,doc.heightOfString(value(v),{width:w-16})+16);
    doc.roundedRect(x,y+15,w,h,2).fillAndStroke(fill,'#d8dee6');
    doc.fillColor('#222222').text(value(v),x+8,y+23,{width:w-16});return h+15;
  };
  const header=()=>{
    doc.image(path.join(__dirname,'JNW.png'),left,22,{fit:[205,48]});
    label('JOB ORDER',375,24);doc.roundedRect(375,39,196,27,2).fill('#f4f6f8');
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#c82f2f').text(value(data.jobOrder),380,42);
    doc.moveTo(24,83).lineTo(571,83).lineWidth(.8).stroke('#0f304d');
  };
  header();let y=98;
  const need=h=>{if(y+h>810){doc.addPage();header();y=98;}};
  const date=value(data.date).replace(/^(\d{4})-(\d{2})-(\d{2})$/,'$3/$2/$1');
  y+=Math.max(field('COMPANY',data.company,left,y,half),field('DATE',date,left+half+gap,y,half))+12;
  y+=field('REQUESTED BY',data.requestedBy,left,y,half)+12;
  for(const [title,v,min] of [['COMPLAINT',data.complaint,48],['ACTION TAKEN',data.actionTaken,72]]){
    doc.font('Helvetica').fontSize(10);need(Math.max(min,doc.heightOfString(value(v),{width:width-16})+16)+27);
    y+=field(title,v,left,y,width,min)+12;
  }
  const parts=data.parts?.length?data.parts:[{}];
  const partsHeader=()=>{label('S/NO',left,y);label('MATERIALS AND PARTS USED',72,y);label('QUANTITY',475,y);y+=16;};
  need(60);partsHeader();
  parts.forEach((p,i)=>{
    doc.font('Helvetica').fontSize(10);
    const h=Math.max(27,doc.heightOfString(value(p.description),{width:375})+16,doc.heightOfString(value(p.quantity ?? p.charge),{width:80})+16);
    if(y+h>810){doc.addPage();header();y=98;partsHeader();}
    [[left,40,p.serial||i+1,'#f4f6f8'],[72,395,p.description,'#ffffff'],[475,96,p.quantity??p.charge,'#ffffff']].forEach(([x,w,v,fill])=>{
      doc.roundedRect(x,y,w,h,2).fillAndStroke(fill,'#d8dee6');doc.font('Helvetica').fontSize(10).fillColor('#222222').text(value(v),x+8,y+8,{width:w-16});
    });y+=h+6;
  });
  y+=8;need(80);doc.font('Helvetica').fontSize(11).fillColor('#222222').text('Labour Description',left,y);y+=25;
  const third=(width-24)/3;
  y+=Math.max(field('MAN',data.labourMan,left,y,third),field('HOURS',data.labourHours,left+third+12,y,third),field('TOTAL HRS',data.labourTotalHours,left+2*(third+12),y,third,28,'#f4f6f8'))+12;
  doc.font('Helvetica').fontSize(10);need(Math.max(48,doc.heightOfString(value(data.remarks),{width:width-16})+16)+27);
  y+=field('REMARKS',data.remarks,left,y,width,48)+12;
  need(148);
  [['AUTHORISED NAME & SIGNATURE','authorisedName','customerSignature',left],['TECHNICIAN NAME & SIGNATURE','technicianName','technicianSignature',left+half+gap]].forEach(([title,nameKey,key,x])=>{
    label(title,x,y);doc.roundedRect(x,y+20,half,24,2).fillAndStroke('#ffffff','#d8dee6');
    doc.font('Helvetica').fontSize(10).fillColor('#222222').text(value(data[nameKey]),x+8,y+27,{width:half-16});
    doc.roundedRect(x,y+52,half,86,2).fillAndStroke('#ffffff','#d8dee6');
    const sig=data.signatures?.[key];
    if(sig){if(!/^data:image\/png;base64,/.test(sig))throw new Error('Invalid signature image');doc.image(Buffer.from(sig.split(',')[1],'base64'),x+5,y+57,{fit:[half-10,74],align:'center',valign:'center'});}
    doc.rect(x,y+133,half,5).fill('#e6ebf0');
  });
  doc.end();
});
