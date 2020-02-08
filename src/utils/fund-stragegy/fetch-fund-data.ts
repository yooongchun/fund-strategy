
import axios from 'axios'
import { notification } from 'antd'
import { dateFormat, roundToFix } from '../common'

// TODO: 使用 fetch-jsonp
const getJSONP = window['getJSONP']



export interface FundDataItem {
  date: string
  val: number
  accumulatedVal: number
  growthRate: number
  bonus: number
  isBonusPortion?: boolean // FHSP: "每份基金份额折算1.020420194份"

}

export interface FundJson {
  all: Record<string, FundDataItem>
  bonus: Record<string, FundDataItem>,
}

/**
 * 上证指数数据
 */
// export type ShangZhengData = Record<string, Pick< FundDataItem, 'date'|'val'>>

/**
 * 拉取数据, 260108
 */
export const getFundData = async (fundCode: string | number, size: number | [any, any]): Promise<FundJson> => {
  const page = 1
  let pageSize: number
  let startDate = '', endDate = ''
  if (Array.isArray(size)) {
    pageSize = (new Date(size[1]).getTime() - new Date(size[0]).getTime()) / 1000 / 60 / 60 / 24
    startDate = dateFormat(new Date(size[0]))
    endDate = dateFormat(new Date(size[1]))
  } else {
    pageSize = size
  }

  const path = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=${page}&pageSize=${Math.floor(pageSize)}&startDate=${startDate}&endDate=${endDate}&_=${Date.now()}`

  return new Promise((resolve) => {
    getJSONP(path, (resp) => {
      let json = resp
      const historyVal = json.Data.LSJZList // 历史净值
      // 日期    FSRQ，  date
      // 单位净值 DWJZ，  val
      // 累计净值 LJJX，  accumulatedVal
      // 日增长率 JZZZL   growthRate
      // 分红送配 FHFCZ  bonus
      // FHSP: "每份基金份额折算1.020420194份"

      let previousItem
      const formatResult = historyVal.reduce((result, item) => {
        const curFundObj: FundDataItem = {
          date: item.FSRQ,
          val: item.DWJZ,
          accumulatedVal: item.LJJZ,
          growthRate: item.JZZZL,
          bonus: item.FHFCZ
        }

        result.all[curFundObj.date] = curFundObj

        if (curFundObj.bonus) {
          result.bonus[curFundObj.date] = curFundObj

          // 分红分为 分红派送，以及份额折算两种
          if ((item.FHSP as string).startsWith('每份基金份额折算')) {
            curFundObj.isBonusPortion = true
            // curFundObj.bonus = previousItem.val * (1 + curFundObj.growthRate / 100) * (1 - 1 / curFundObj.bonus)
          }
        }

        previousItem = curFundObj

        return result
      }, {
        bonus: {},
        all: {}
      })

      resolve(formatResult)
    })

  })





}


export enum IndexFund {
  ShangZheng = '1.000001',
}

/**
 * 指数数据
 */
export interface IndexData {
  date: string
  val: number
  ema12: number
  ema26: number
  diff: number
  // ema9: number 
  dea: number // dea = ema(diff, 9)
  macd: number

  macdPosition: number // 当前 macd 百分位
  index?: number
}

const EMA = (close: number, days: number, opt: {
  previousDate?: string,
  curDate: string,
  data: Record<string, IndexData>
}): number => {

  const { previousDate, curDate } = opt
  // 如果是首日上市价，那么初始 ema 为首日收盘价
  if (!previousDate) {
    return opt.data[curDate].val
  }
  const field = days === 9 ? `dea` : `ema${days}`
  const previousEMA = Number(opt.data[previousDate][field])

  return (2 * close + (days - 1) * previousEMA) / (days + 1)
}


/**
 * 计算 macd 百分位
 * @param indexData - 指数数据 
 */
const calcMacdPosition = (indexData: IndexData[])=>{
  let indexDataGroups: IndexData[][] = []
  indexData.reduce((previousItem, curItem)=>{
    const isSameSide = previousItem.macd * curItem.macd
    if(previousItem.macd === 0) {
      indexDataGroups.push([curItem])
      return curItem
    }

    if(isSameSide < 0) {
      // 不同边的 macd 时，创建一个新的 group
      indexDataGroups.push([curItem])
    } else {
      // 同一边的 macd
      indexDataGroups[indexDataGroups.length - 1].push(curItem) 
    }
    
    return curItem
  })
  
  // 第一天的 macd 是 0
  indexData[0].macdPosition = 0

  indexDataGroups.forEach((curIndexGroup)=>{
    const maxMacd = Math.max(...curIndexGroup.map(item => Math.abs(item.macd)))
    curIndexGroup.forEach(item => {
      const position = Math.abs(item.macd) / maxMacd
      item.macdPosition = roundToFix(position)
    })
  })
}

/**
 * 计算 macd 值
 * @param indexDataMap 源数据 map 值
 */
export const calcMACD = (indexDataMap: Record<string, IndexData>) => {
  const indexList = Object.values(indexDataMap)

  indexList.forEach((item, index) => {
    const curObj = item
    if (curObj.ema12 || curObj.ema12 === 0) {
      return
    }
    const previousDate = indexList[index - 1] ? indexList[index - 1].date : undefined
    curObj.ema12 = EMA(curObj.val, 12, {
      previousDate,
      curDate: curObj.date,
      data: indexDataMap
    })
    curObj.ema26 = EMA(curObj.val, 26, {
      previousDate,
      curDate: curObj.date,
      data: indexDataMap
    })

    curObj.diff = curObj.ema12 - curObj.ema26
    curObj.dea = previousDate ? EMA(curObj.diff, 9, {
      previousDate,
      curDate: curObj.date,
      data: indexDataMap
    }) : 0
    curObj.macd = 2 * (curObj.diff - curObj.dea)
  })

  calcMacdPosition(indexList)

  return indexDataMap
}

/**
 * 根据 macd 计算出交易点
 * @param indexData 指数数据
 * @param position 交易 macd 位置
 */
export const txnByMacd = (indexData: IndexData[], position: number) =>{
  indexData[0].index = 0 

  let indexDataGroups: IndexData[][] = [[indexData[0]]]
  indexData.reduce((previousItem, curItem, curIndex)=>{
    curItem.index = curIndex
    const isSameSide = previousItem.macd * curItem.macd
     
    if(isSameSide < 0) {
      // 不同边的 macd 时，创建一个新的 group
      indexDataGroups.push([curItem])
    } else {
      // 同一边的 macd
       
      indexDataGroups[indexDataGroups.length - 1].push(curItem) 
    }
    
    return curItem
  })

  const buyDateList: IndexData[] = []
  const sellDateList: IndexData[] = []
  
  // 对分组后的 indexData 迭代
  indexDataGroups.forEach(curIndexList => {
    const maxMacdIndexObj = curIndexList.find(indexObj => indexObj.macdPosition === 1)!
    const greaterIndexList = curIndexList.filter(item => item.macdPosition >= position)
    
    const buySellIndex = greaterIndexList[greaterIndexList.length - 1].index! + 1

    // 如果不存在
    if(!indexData[buySellIndex]) {
      return 
    }

    // 默认 greaterIndexList 是连续的，TODO: 有多个峰存在的情况
    if(maxMacdIndexObj.macd > 0) {
      // 上涨行情， macdPosition 大于 xxx 的倒数第一个值，该值就是卖出点
      sellDateList.push(indexData[buySellIndex])
    } else {
      // 同理，在下跌行情中，macdPosition 大于 50% 的倒数第一个值，该值就是买入点
      buyDateList.push(indexData[buySellIndex])
    }
  })

  return {
    buyDateList,
    sellDateList
  }
  
}



/**
 * 获取指数基金
 * */
export const getIndexFundData = async (opt: {
  code: string,
  range: [number | string, number | string]
}) => {
  // http://img1.money.126.net/data/hs/kline/day/history/2020/0000001.json
  /* 数据结构
  ["20200123",3037.95,2976.53,3045.04,2955.35,27276323400,-2.75]
  日期，今开，今日收盘价，最高，最低，成交量，跌幅
   */

  /**
   * http://60.push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.399997&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&beg=20160205&end=20200205&ut=fa5fd1943c7b386f172d6893dbfba10b&cb=cb30944405113958
   * 响应： "2020-02-06,7386.27,7452.25,7461.18,7302.34,1936321,14723348992.00"
   * 时间，今开，今收，最高，最低，成交量/手，成交额
   */

  // q.stock.sohu.com/hisHq?code=zs_000001&start=20130930&end=20200201&stat=1&order=D&period=d&rt=jsonp
  // ["2020-01-23", "3037.95", "2976.53", "-84.23", "-2.75%", "2955.35", "3045.04", "272763232",32749038.00]
  // 日期，今开，收盘，下跌，跌幅，最低，最高，成交量/手，成交额/万
  let [start, end] = opt.range.map(item => dateFormat(item))
  const savedData = JSON.parse(localStorage.getItem(opt.code) || '{}')
  const dateList = Object.keys(savedData)
  const [savedStart, savedEnd] = [dateList[0], dateList[dateList.length - 1]]

  // 如果之前没有该指数数据，拉取全部数据
  if (dateList.length === 0) {
    start = '19900101'
    end = dateFormat(Date.now())
  } else {
    // 增量更新时间范围的 指数数据
    if ((new Date(opt.range[0]) >= new Date(savedStart)) && (new Date(opt.range[1]) <= new Date(savedEnd))) {
      return savedData
    } else {
      if (new Date(opt.range[0]) >= new Date(savedStart)) {
        start = savedEnd
      }
      if (new Date(opt.range[1]) <= new Date(savedEnd)) {
        end = savedStart
      }
    }
  }
  return new Promise((resolve) => {
    getJSONP(`//60.push2his.eastmoney.com/api/qt/stock/kline/get?secid=${opt.code}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&beg=${start.replace(/-/g, '')}&end=${end.replace(/-/g, '')}&ut=fa5fd1943c7b386f172d6893dbfba10b`, (res) => {
      console.log(`指数基金 响应`, res.data.klines)
      const list = res.data.klines
      const indexFundData = list.reduce((result, cur: string) => {
        const [date, , val] = cur.split(',')
        result[date] = {
          date,
          val
        }
        return result
      }, {})


      let mergedData = {
        ...savedData,
        ...indexFundData
      }
      const sortedDates = Object.keys(mergedData).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      
      mergedData = sortedDates.reduce((result, cur) => {
        result[cur] = mergedData[cur]
        return result
      }, {})
      console.log('sorted date', mergedData)

      calcMACD(mergedData)


      // console.log('shangZhengData with eacd', Object.values(mergedData).slice(0, 10), mergedData) 



      localStorage.setItem(opt.code, JSON.stringify(mergedData))

      resolve(mergedData)
    })
  })


}

/**
 * 指数信息对象
 */
export interface SearchIndexResp {
  code: string
  name: string
  id: string
}
/**
 * 指数动态查询
 */
export const searchIndex = async (input: string): Promise<SearchIndexResp[]> => {
  // http://searchapi.eastmoney.com/api/suggest/get?cb=jQuery112408632397893769632_1580928562563&input=%E4%B8%AD%E8%AF%81%E7%99%BD%E9%85%92&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&markettype=&mktnum=&jys=&classify=&securitytype=&count=5&_=1580928562702
  return new Promise((resolve) => {
    const path = `//searchapi.eastmoney.com/api/suggest/get?input=${input}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&markettype=&mktnum=&jys=&classify=&securitytype=&count=5&_=${Date.now()}`

    getJSONP(path, (resp) => {
      let data = resp.QuotationCodeTable.Data || []
      data = data.filter(item => item.Classify === 'Index')

      const result = data.map(item => {
        return {
          code: item.Code,
          name: item.Name,
          id: item.QuoteID
        }
      })

      resolve(result)
    })
  })
}

/**
 * 基金对象信息
 */
export interface FundInfo {
  code: string
  name: string
}
/**
 * 基金动态查询
 */
export const getFundInfo = async (key): Promise<FundInfo[]> => {
  return new Promise((resolve) => {
    const path = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=10&t=700&IsNeedBaseInfo=0&IsNeedZTInfo=0&key=${key}&_=${Date.now()}`

    getJSONP(path, (resp) => {
      const result = resp.Datas.map(item => {
        return {
          code: item.CODE,
          name: item.NAME
        }
      })

      resolve(result)
    })
  })

}
