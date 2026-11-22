import baostock as bs, time
bs.login()
t=time.time()
rs = bs.query_history_k_data_plus('sz.300059','date,time,open,high,low,close,volume,amount',
    start_date='2020-01-01', end_date='2026-11-14', frequency='5', adjustflag='2')
n=0
while rs.error_code=='0' and rs.next(): n+=1
print('rows',n,'sec',round(time.time()-t,1))
bs.logout()
