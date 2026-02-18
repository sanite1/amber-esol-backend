import { Model, PopulateOptions } from "mongoose";
export interface IQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
}
type IFindBy<T> = Partial<Record<keyof T, any>>;

export const paginatedFind = async <T>(
  Model: Model<T>,
  findBy?: IFindBy<T>,
  populate?: PopulateOptions | (PopulateOptions | string)[],
  query?: IQuery,
) => {
  let page = 0;
  let pageSize = 10;
  let sort: string | undefined;
  if (query) {
    const {
      page: pageNumber = 0,
      pageSize: queryPageSize = 10,
      sort: querySort,
    } = query;
    page = Number(pageNumber);
    pageSize = Number(queryPageSize);
    sort = querySort;
  }
  const sortField = sort ? sort.replace("-", "") : "createdAt";
  const sortOrder = sort ? (sort.startsWith("-") ? -1 : 1) : -1;
  const total = await Model.countDocuments(findBy);
  const results = await Model.find({
    ...(findBy && {
      ...findBy,
    }),
  })
    .skip(pageSize * page)
    .limit(pageSize)
    .sort({
      [sortField]: sortOrder,
    })
    .populate(populate || []);
  return { results, total, page, pageSize };
};
