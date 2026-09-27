"""Sxemadan to'rli kattalashtirilgan bo'lak kesadi (koordinatalarni o'qish uchun yordamchi)."""
import sys, cv2
im = cv2.imread('reference/scheme_landscape.jpg')
x0,y0,x1,y1,scale,out = int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),float(sys.argv[5]),sys.argv[6]
c=cv2.resize(im[y0:y1,x0:x1],None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
for x in range((x0//10+1)*10, x1, 10):
    X=int((x-x0)*scale); major = x%50==0
    cv2.line(c,(X,0),(X,c.shape[0]),(0,200,255) if major else (0,120,160),1 if major else 1)
    if major: cv2.putText(c,str(x),(X+2,12),cv2.FONT_HERSHEY_SIMPLEX,0.4,(0,0,255),1)
for y in range((y0//10+1)*10, y1, 10):
    Y=int((y-y0)*scale); major = y%50==0
    cv2.line(c,(0,Y),(c.shape[1],Y),(0,200,255) if major else (0,120,160),1)
    if major: cv2.putText(c,str(y),(2,Y-2),cv2.FONT_HERSHEY_SIMPLEX,0.4,(0,0,255),1)
cv2.imwrite(out,c)
