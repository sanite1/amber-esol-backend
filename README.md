# Invoice App

An Invoice Management Application built using Express.js, MongoDB, and TypeScript. This application allows users to manage clients, products, and invoices, providing a seamless experience for small to medium-sized businesses to automate their invoicing process.

# Documentation

```
https://documenter.getpostman.com/view/17301223/2sA3s6DpEs
```

## Table of Contents

- [Invoice App](#invoice-app)
- [Documentation](#documentation)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Technologies Used](#technologies-used)
  - [Installation](#installation)
  - [Usage](#usage)
  - [Project Structure](#project-structure)
  - [API Endpoints](#api-endpoints)
    - [Clients](#clients)
    - [Products](#products)
    - [Invoices](#invoices)
    - [Users](#users)

## Features

- **Client Management**: Create, read, update, and delete client records.
- **Product Management**: Manage products with the ability to upload images.
- **Invoice Management**: Generate and manage invoices for different clients.
- **Authentication**: Secure routes with JWT authentication.
- **Validation**: Request validation using express-validator.
- **File Uploads**: Handle file uploads using Multer and Cloudinary.
- **Email Notifications**: Send invoice notifications via email using Nodemailer.

## Technologies Used

- **Backend**: Node.js, Express.js
- **Database**: MongoDB, Mongoose
- **Authentication**: JSON Web Tokens (JWT)
- **File Storage**: Multer, Cloudinary
- **Validation**: express-validation, express-validator
- **Email**: Nodemailer

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/invoice-app.git
   ```
2. Navigate to the project directory:
   ```bash
   cd invoice-app
   ```
3. Create a `.env` file in the root directory and configure your environment variables:

   ```bash
   MONGODB_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret
   CLOUDINARY_URL=your_cloudinary_url
   CLOUD_NAME=your-cloud_name
   CLOUDINARY_API_KEY=your_cloudinary_apikey
   CLOUDINARY_API_SECRET=your_cloudinary_apisecret
   AUTH_EMAIL=your_gmail
   AUTH_PASS=your_gmail_api_key
   JWT_SECRET=your_jwt_secret
   DOMAIN_NAME=https://example.com

   ```

4. Build the project:

   ```bash
   pnpm run build
   ```

5. Start the development server:

   ```bash
   pnpm run dev
   ```

## Usage

- Access the API endpoints using a tool like Postman or integrate with a frontend application.
- Authentication is required for most endpoints. Obtain a token by logging in or creating a new user.

## Project Structure

- `/src`: Contains all source code files.
  - `/controllers`: Contains controller files for handling requests.
  - `/models`: Contains Mongoose models.
  - `/routes`: Contains Express routes.
  - `/middlewares`: Contains custom middleware for authentication and the global error handler.
  - `/errors`: Contains custom error classes.
  - `/interfaces`: Contains custom interfaces.
  - `/servicies`: Contains custom functions.
  - `/validations`: Contains validation rules for different routes.
  - `/config`: Configuration files for the application. -`index.ts`: Main entry point

## API Endpoints

### Clients

- `GET /clients`: Get all clients.
- `POST /clients`: Create a new client.
- `GET /clients/:id`: Get a client by ID.
- `PATCH /clients/:id`: Update a client by ID.
- `DELETE /clients/:id`: Delete a client by ID.

### Products

- `GET /products`: Get all products.
- `POST /products`: Create a new product.
- `GET /products/:id`: Get a product by ID.
- `PATCH /products/:id`: Update a product by ID.
- `DELETE /products/:id`: Delete a product by ID.

### Invoices

- `GET /invoices`: Get all invoices.
- `POST /invoices`: Create a new invoice.
- `GET /invoices/:id`: Get an invoice by ID.
- `PATCH /invoices/:id`: Update an invoice by ID.
- `DELETE /invoices/:id`: Delete an invoice by ID.

### Users

- `POST /users`: Create a new user.
- `POST /users/login`: User login.
- `GET /users/:id`: Get a user by ID.
- `PATCH /users/:id`: Update a user by ID.
- `POST /users/forgot-password`: Request password reset.
- `PATCH /users/reset-password/:id/:token`: Reset password.
- `PATCH /users/update-password/:id`: Update password.
