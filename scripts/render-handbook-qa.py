import argparse, subprocess, sys, json, os
from pathlib import Path
from PIL import Image, ImageDraw

parser=argparse.ArgumentParser(); parser.add_argument('root')
parser.add_argument('--renderer', default=os.environ.get('MUNWORD_DOCX_RENDERER'),
                    help='Path to an external render_docx.py compatible renderer')
args=parser.parse_args()
root=Path(args.root)
if not args.renderer or not Path(args.renderer).is_file():
    parser.error('Provide --renderer or MUNWORD_DOCX_RENDERER pointing to render_docx.py')
renderer=Path(args.renderer)
# The isolated renderer needs an explicit font catalogue on macOS. This affects
# QA rendering only; exported documents retain the handbook's font names.
font_config = os.environ.get('MUNWORD_QA_FONTCONFIG')
if font_config: os.environ['FONTCONFIG_FILE'] = font_config
for file in sorted(root.glob('*.docx')):
    dest=root/file.stem
    subprocess.run([sys.executable,str(renderer),str(file),'--output_dir',str(dest),'--emit_pdf','--dpi','115'],check=True)
    # Some macOS Poppler builds omit embedded CJK glyphs in the default raster
    # backend. Cairo provides an independent PDF-to-pixel check, when supplied.
    cairo=os.environ.get('MUNWORD_QA_CAIRO')
    if cairo:
        subprocess.run([cairo,'-png','-r','115',str(dest/(file.stem+'.pdf')),str(dest/'cairo-page')],check=True)
        for page in dest.glob('cairo-page-*.png'):
            page.rename(dest/('page-'+str(int(page.stem.rsplit('-',1)[1]))+'.png'))
    print(file.name,len(list(dest.glob('page-*.png'))),flush=True)
pages=sorted(root.glob('*/page-*.png'))
for start in range(0,len(pages),6):
    sheet=Image.new('RGB',(1650,1600),'white'); draw=ImageDraw.Draw(sheet)
    for i,file in enumerate(pages[start:start+6]):
        image=Image.open(file); image.thumbnail((540,745)); x,y=(i%3)*550,(i//3)*800
        sheet.paste(image,(x,y+30)); draw.text((x+4,y+5),file.parent.name+'/'+file.name,fill='black')
    sheet.save(root/f'contact-{start+1}.jpg')
print('TOTAL_PAGES',len(pages))
