class ApiResponse {
  message: string;
  statusCode: number;
  data: any;

  constructor(statusCode: number, message: string, data?: any) {
    this.message = message;
    this.statusCode = statusCode;
    if (data) {
      this.data = data;
    }
  }
}

export default ApiResponse;
